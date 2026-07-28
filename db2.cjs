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
  const res = await client.query("SELECT id, file_name, file_url, status FROM pad_documents WHERE status = 'completed'");
  console.table(res.rows);
  await client.end();
}
test().catch(console.error);
