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
  const res = await client.query("SELECT * FROM files WHERE id = 'b90852b9-0ba0-4e6b-8803-5daed044c462'");
  console.log(JSON.stringify(res.rows, null, 2));
  await client.end();
}
test().catch(console.error);
