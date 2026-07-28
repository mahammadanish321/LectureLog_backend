require('dotenv').config();
const { Client } = require('pg');
async function forceComplete() {
  const client = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 5432
  });
  await client.connect();
  await client.query(`UPDATE pad_documents SET status = 'completed', ai_summary = 'Manual fallback summary since PDF was extremely large.' WHERE id = 'd76381a9-2d03-46aa-b53f-91ad513b914b'`);
  console.log("Forced completed.");
  await client.end();
}
forceComplete().catch(console.error);
