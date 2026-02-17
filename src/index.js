/**
 * NAFA Audit Sync Worker
 *
 * Syncs NAFA audit files from Monday.com to Close CRM.
 * When a file is uploaded to the NAFA file column on a Monday.com board,
 * this worker:
 *   1. Downloads the file from Monday.com
 *   2. Uploads it to Close CRM (two-step: init → S3)
 *   3. Stores a copy in Cloudflare R2 for public hosting
 *   4. Updates the Close lead's custom field with the R2 public URL
 *   5. Creates a Close note with the file attachment
 *
 * Environment variables (set as Cloudflare Worker secrets):
 *   MONDAY_API_TOKEN       - Monday.com API token
 *   CLOSE_API_KEY          - Close CRM API key
 *   NAFA_FILE_COLUMN_ID    - Monday.com column ID for the NAFA file upload
 *   CLOSE_LEAD_ID_COLUMN_ID - Monday.com column ID containing the Close Lead ID
 *   CLOSE_NAFA_URL_FIELD_ID - Close CRM custom field ID for the NAFA report URL
 *   R2_PUBLIC_URL          - Public base URL for the R2 bucket
 *
 * R2 Binding:
 *   NAFA_BUCKET            - Bound to the `nafa-audit-pdfs` R2 bucket
 */

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const body = await request.json();
      console.log('Incoming payload:', JSON.stringify(body).substring(0, 500));

      // Monday.com webhook challenge verification
      if (body.challenge) {
        return new Response(JSON.stringify({ challenge: body.challenge }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Extract item ID from various Monday.com payload formats
      let itemId = null;

      if (body.event) {
        const event = body.event;

        // Only process changes on the NAFA file column
        if (event.columnId && event.columnId !== env.NAFA_FILE_COLUMN_ID) {
          return new Response('Ignoring non-NAFA column change', { status: 200 });
        }

        // Skip if file was removed (empty value)
        if (event.value && (event.value === '{}' || event.value === '{"files":[]}')) {
          return new Response('File was removed, skipping', { status: 200 });
        }

        itemId = event.pulseId || event.itemId;
      } else if (body.payload) {
        const fields = body.payload.inputFields || body.payload.inboundFieldValues || {};
        itemId = fields.itemId || fields.pulseId;
        if (!itemId && body.payload.itemId) {
          itemId = body.payload.itemId;
        }
      } else {
        itemId = body.itemId || body.pulseId;
      }

      if (!itemId) {
        console.error('Could not extract item ID from payload');
        return new Response('No item ID found in payload', { status: 200 });
      }

      console.log(`Processing NAFA file upload for item ${itemId}`);

      // Fetch item data from Monday.com (name, Close Lead ID, file assets)
      const itemData = await getMondayItemData(itemId, env);
      if (!itemData) {
        console.error(`Failed to fetch item data for item ${itemId}`);
        return new Response('Failed to fetch item data', { status: 500 });
      }

      const { closeLeadId, name: itemName, assets } = itemData;

      if (!closeLeadId) {
        console.error(`No Close Lead ID found for item ${itemId} (${itemName})`);
        return new Response('No Close Lead ID on item', { status: 200 });
      }

      if (!assets || assets.length === 0) {
        console.error(`No file assets found for item ${itemId}`);
        return new Response('No file assets found', { status: 200 });
      }

      // Process each uploaded file
      for (const asset of assets) {
        console.log(`Processing file: ${asset.name} (${asset.id})`);

        const fileData = await downloadMondayFile(asset.public_url);
        if (!fileData) {
          console.error(`Failed to download file ${asset.name} from Monday`);
          continue;
        }

        const contentType = getMimeType(asset.name);

        // Upload to Close CRM
        const closeFileUrl = await uploadFileToClose(asset.name, contentType, fileData, env);
        if (!closeFileUrl) {
          console.error(`Failed to upload file ${asset.name} to Close`);
          continue;
        }

        // Upload to R2 and update Close lead custom field
        const r2PublicUrl = await uploadFileToR2(asset.name, contentType, fileData, itemId, env);
        if (r2PublicUrl) {
          await updateCloseLeadField(closeLeadId, r2PublicUrl, env);
        } else {
          console.error('Failed to upload file to R2, skipping custom field update');
        }

        // Create a note on the Close lead with the file attachment
        const noteCreated = await createCloseNote(
          closeLeadId, asset.name, closeFileUrl, contentType, itemName, itemId, env
        );

        if (noteCreated) {
          console.log(`Successfully synced ${asset.name} to Close lead ${closeLeadId}`);
        } else {
          console.error(`Failed to create note on Close lead ${closeLeadId}`);
        }
      }

      return new Response('OK', { status: 200 });
    } catch (err) {
      console.error('Worker error:', err.message, err.stack);
      return new Response('Internal error', { status: 500 });
    }
  },
};

// ---------------------------------------------------------------------------
// Monday.com helpers
// ---------------------------------------------------------------------------

/**
 * Fetch item data from Monday.com including name, Close Lead ID, and file assets.
 * Only fetches assets from the specific NAFA file column to avoid processing
 * unrelated files attached to the item.
 */
async function getMondayItemData(itemId, env) {
  const query = `
    query ($itemId: [ID!]!, $columnId: [String!]!) {
      items(ids: $itemId) {
        id
        name
        column_values(ids: ["${env.CLOSE_LEAD_ID_COLUMN_ID}"]) {
          id
          text
          ... on MirrorValue {
            display_value
          }
        }
        assets(column_ids: $columnId) {
          id
          name
          public_url
          file_extension
          file_size
          created_at
        }
      }
    }
  `;

  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: env.MONDAY_API_TOKEN,
    },
    body: JSON.stringify({
      query,
      variables: {
        itemId: [String(itemId)],
        columnId: [env.NAFA_FILE_COLUMN_ID],
      },
    }),
  });

  const data = await response.json();
  if (data.errors) {
    console.error('Monday API errors:', JSON.stringify(data.errors));
    return null;
  }

  const item = data.data?.items?.[0];
  if (!item) return null;

  const closeLeadIdColumn = item.column_values?.find(
    (col) => col.id === env.CLOSE_LEAD_ID_COLUMN_ID
  );
  const rawLeadId = closeLeadIdColumn?.text || closeLeadIdColumn?.display_value || null;

  // Sort by created_at descending and take only the most recent asset
  const allAssets = item.assets || [];
  allAssets.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const latestAsset = allAssets.length > 0 ? [allAssets[0]] : [];

  return {
    name: item.name,
    closeLeadId: rawLeadId?.trim() || null,
    assets: latestAsset,
  };
}

/**
 * Download a file from a Monday.com public URL.
 */
async function downloadMondayFile(publicUrl) {
  if (!publicUrl) return null;

  try {
    const response = await fetch(publicUrl);
    if (!response.ok) {
      console.error(`Monday file download failed: ${response.status}`);
      return null;
    }
    return await response.arrayBuffer();
  } catch (err) {
    console.error('File download error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Close CRM helpers
// ---------------------------------------------------------------------------

/**
 * Upload a file to Close CRM using their two-step upload process:
 *   1. POST to /files/upload/ to get a presigned S3 URL
 *   2. POST the file to S3
 * Returns the Close download URL for the uploaded file.
 */
async function uploadFileToClose(filename, contentType, fileData, env) {
  const closeAuth = btoa(`${env.CLOSE_API_KEY}:`);

  // Step 1: Initialize the upload
  const initResponse = await fetch('https://api.close.com/api/v1/files/upload/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${closeAuth}`,
    },
    body: JSON.stringify({ filename, content_type: contentType }),
  });

  if (!initResponse.ok) {
    const errText = await initResponse.text();
    console.error(`Close file init failed (${initResponse.status}): ${errText}`);
    return null;
  }

  const initData = await initResponse.json();
  const uploadUrl = initData.upload?.url;
  const uploadFields = initData.upload?.fields;
  const downloadUrl = initData.download?.url;

  if (!uploadUrl || !uploadFields || !downloadUrl) {
    console.error('Close file init response missing required fields');
    return null;
  }

  // Step 2: Upload file to S3
  const formData = new FormData();
  for (const [key, value] of Object.entries(uploadFields)) {
    formData.append(key, value);
  }
  const blob = new Blob([fileData], { type: contentType });
  formData.append('file', blob, filename);

  const s3Response = await fetch(uploadUrl, {
    method: 'POST',
    body: formData,
  });

  if (s3Response.status !== 201 && s3Response.status !== 204) {
    const errText = await s3Response.text();
    console.error(`S3 upload failed (${s3Response.status}): ${errText}`);
    return null;
  }

  console.log(`File uploaded to Close: ${downloadUrl}`);
  return downloadUrl;
}

/**
 * Create a note on a Close lead with the uploaded file as an attachment.
 */
async function createCloseNote(leadId, filename, fileUrl, contentType, itemName, itemId, env) {
  const closeAuth = btoa(`${env.CLOSE_API_KEY}:`);
  const today = new Date().toISOString().split('T')[0];

  const noteBody = {
    lead_id: leadId,
    note: `📋 **NAFA Audit File Uploaded**\n\nFile: ${filename}\nSource: Monday.com - Credit Audits Board\nLead: ${itemName}\nDate: ${today}\n\nThis file was automatically synced from Monday.com.`,
    attachments: [
      {
        url: fileUrl,
        filename,
        content_type: contentType,
      },
    ],
  };

  const response = await fetch('https://api.close.com/api/v1/activity/note/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${closeAuth}`,
    },
    body: JSON.stringify(noteBody),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`Close note creation failed (${response.status}): ${errText}`);
    return false;
  }

  return true;
}

/**
 * Update a Close lead's custom field with the R2 public URL.
 */
async function updateCloseLeadField(leadId, r2Url, env) {
  const closeAuth = btoa(`${env.CLOSE_API_KEY}:`);

  try {
    const response = await fetch(`https://api.close.com/api/v1/lead/${leadId}/`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${closeAuth}`,
      },
      body: JSON.stringify({
        [`custom.${env.CLOSE_NAFA_URL_FIELD_ID}`]: r2Url,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Close lead field update failed (${response.status}): ${errText}`);
      return false;
    }

    console.log(`Updated NAFA Report URL on Close lead ${leadId}`);
    return true;
  } catch (err) {
    console.error('Close lead update error:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// R2 / utility helpers
// ---------------------------------------------------------------------------

/**
 * Upload a file to the R2 bucket and return the public URL.
 */
async function uploadFileToR2(filename, contentType, fileData, itemId, env) {
  try {
    const r2Key = `${itemId}/${filename}`;
    await env.NAFA_BUCKET.put(r2Key, fileData, {
      httpMetadata: { contentType },
    });

    const encodedKey = `${itemId}/${encodeURIComponent(filename)}`;
    const publicUrl = `${env.R2_PUBLIC_URL}/${encodedKey}`;
    console.log(`File uploaded to R2: ${publicUrl}`);
    return publicUrl;
  } catch (err) {
    console.error('R2 upload error:', err.message);
    return null;
  }
}

/**
 * Get MIME type from a filename extension.
 */
function getMimeType(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeTypes = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    txt: 'text/plain',
    html: 'text/html',
    zip: 'application/zip',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}
