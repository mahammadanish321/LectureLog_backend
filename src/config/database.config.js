import pg from "pg";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();
const { Pool } = pg;

export const DATABASE_NAME = process.env.DB_NAME || "Merge";
export const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || null;

const parseSslSetting = () => {
  const raw = process.env.DB_SSL;
  if (!raw) {
    return false;
  }

  return ["1", "true", "yes"].includes(raw.toLowerCase())
    ? { rejectUnauthorized: false }
    : false;
};

const poolConfig = DATABASE_URL
  ? {
    connectionString: DATABASE_URL,
    ssl: parseSslSetting()
  }
  : {
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
    database: DATABASE_NAME,
    port: Number(process.env.DB_PORT) || 5432,
    ssl: parseSslSetting(),
    max: 10,
    idleTimeoutMillis: 30000
  };

const pool = new Pool(poolConfig);

pool.on("error", (error) => {
  console.error("[Database Pool Error]", error);
});

pool.on("connect", (client) => {
  client.query("SET TIME ZONE 'Asia/Kolkata'").catch((err) => {
    console.error("[Database Connection] Failed to set timezone:", err.message);
  });
});

export const testDatabaseConnection = async () => {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");

    // Connect to MongoDB
    if (process.env.MONGODB_URI) {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log("✅ [Database] Connected to MongoDB.");
    } else {
      console.warn("⚠️ [Database] MONGODB_URI not found. MongoDB features will be disabled.");
    }
    // Ensure notifications table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        receiver_id INTEGER NOT NULL,
        receiver_role VARCHAR(50) NOT NULL,
        sender_id INTEGER,
        sender_name VARCHAR(255),
        sender_image TEXT,
        type VARCHAR(50) NOT NULL,
        session_type VARCHAR(30),
        priority VARCHAR(20) NOT NULL DEFAULT 'normal',
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        metadata JSONB,
        redirect_url VARCHAR(255),
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_receiver ON notifications(receiver_id, receiver_role, is_read);
      CREATE INDEX IF NOT EXISTS idx_notifications_expiry ON notifications(expires_at) WHERE expires_at IS NOT NULL;
      
      CREATE TABLE IF NOT EXISTS pad_ai_chats (
        id SERIAL PRIMARY KEY,
        pad_id UUID NOT NULL,
        role VARCHAR(10) NOT NULL CHECK (role IN ('user', 'bot')),
        content TEXT NOT NULL,
        type VARCHAR(20) NOT NULL DEFAULT 'text',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pad_ai_chats_pad_id ON pad_ai_chats(pad_id);
    `);

    // ── Admin Session & Push Notification Tracking Migration ──
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_session_token VARCHAR(64);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_device_id VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_login_platform VARCHAR(50);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_last_seen TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_login_timestamp TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token VARCHAR(255);
      ALTER TABLE students ADD COLUMN IF NOT EXISTS push_token VARCHAR(255);
    `);

    // ── Attendance Confidence & Threshold Migration ──
    await client.query(`
      ALTER TABLE attendance ADD COLUMN IF NOT EXISTS confidence NUMERIC;
      ALTER TABLE attendance ADD COLUMN IF NOT EXISTS threshold NUMERIC DEFAULT 0.60;
    `);

    // --- ONE-TIME AUTO CLEANUP FOR PRODUCTION ---
    // Automatically delete lingering global "General Class" and "Default Camera" records
    const { rowCount: cCount } = await client.query('DELETE FROM classrooms WHERE organization_id IS NULL');
    if (cCount > 0) console.log(`✅ [Cleanup] Deleted ${cCount} ghost classrooms.`);
    
    const { rowCount: sCount } = await client.query('DELETE FROM subjects WHERE organization_id IS NULL');
    if (sCount > 0) console.log(`✅ [Cleanup] Deleted ${sCount} ghost subjects.`);
    // --------------------------------------------
  } finally {
    client.release();
  }
};

export default pool;
