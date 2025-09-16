const fs = require('fs');
const path = require('path');
require('dotenv').config();

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:3030';
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || 'mcp-zoning-token';
const ZONING_CODES_DIR = './Zoning_Codes';

async function ingestPDFs() {
  try {
    if (!fs.existsSync(ZONING_CODES_DIR)) {
      console.error(`Directory ${ZONING_CODES_DIR} does not exist`);
      return;
    }

    const files = (await fs.promises.readdir(ZONING_CODES_DIR))
      .filter(file => file.toLowerCase().endsWith('.pdf'));

    console.log(`Found ${files.length} PDF files to ingest`);

    for (const file of files) {
      const filePath = path.join(ZONING_CODES_DIR, file);
      console.log(`Ingesting: ${file}`);

      const fileBuffer = await fs.promises.readFile(filePath);
      const formData = new FormData();
      formData.append('file', new Blob([fileBuffer], { type: 'application/pdf' }), file);

      const response = await fetch(`${MCP_SERVER_URL}/ingest`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${MCP_AUTH_TOKEN}`
        },
        body: formData
      });

      if (response.ok) {
        const result = await response.json();
        console.log(`✓ ${file} ingested successfully`);
        console.log(`  File ID: ${result.fileId}`);
        console.log(`  Vector Store: ${result.vectorStoreId}`);
      } else {
        const error = await response.text();
        console.error(`✗ Failed to ingest ${file}: ${error}`);
      }
    }

    console.log('Ingestion complete!');
  } catch (error) {
    console.error('Ingestion error:', error);
  }
}

ingestPDFs();
