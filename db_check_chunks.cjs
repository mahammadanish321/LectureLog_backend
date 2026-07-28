require('dotenv').config();
const { Client } = require('pg');
async function test() {
  const client = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 5432
  });
  await client.connect();
  const res = await client.query('SELECT pd.id, pd.status, (SELECT COUNT(*) FROM document_chunks dc WHERE dc.pad_document_id = pd.id) as chunk_count FROM pad_documents pd ORDER BY pd.created_at DESC LIMIT 5');
  console.table(res.rows);
  await client.end();
}
test().catch(console.error);
