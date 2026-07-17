import pool from './src/config/database.config.js';

const initDb = async () => {
  let client;

  try {
    client = await pool.connect();
    console.log('Connected to PostgreSQL database.');
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        logo_url TEXT,
        primary_color VARCHAR(20) DEFAULT '#105934',
        status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'inactive')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        password VARCHAR(255),
        organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
        college_id VARCHAR(100),
        role VARCHAR(20) NOT NULL DEFAULT 'teacher' CHECK (role IN ('teacher', 'admin')),
        face_embedding JSONB,
        is_active BOOLEAN NOT NULL DEFAULT FALSE,
        status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'deleted')),
        otp_code VARCHAR(6),
        otp_expiry TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (email, organization_id)
      )
    `);

    // Ensure columns exist if table was already created
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
      ALTER TABLE users ALTER COLUMN password DROP NOT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'deleted'));
      ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_code VARCHAR(6);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expiry TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS face_embedding JSONB;
    `);

    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS image_url TEXT;
    `);

    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS cloudinary_id VARCHAR(255);
    `);

    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS face_embeddings JSONB;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS angle_images JSONB DEFAULT '{}'::jsonb;
    `);

    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_face_verified BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    // ── Admin Session & Push Notification Tracking ──
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_session_token VARCHAR(64);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_device_id VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_login_platform VARCHAR(50);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_last_seen TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_login_timestamp TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token VARCHAR(255);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        password VARCHAR(255),
        roll_number VARCHAR(50) NOT NULL,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
        college_id VARCHAR(100) NOT NULL,
        year INTEGER,
        stream VARCHAR(50),
        face_embedding JSONB,
        is_active BOOLEAN NOT NULL DEFAULT FALSE,
        otp_code VARCHAR(6),
        otp_expiry TIMESTAMPTZ,
        status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (roll_number, organization_id),
        UNIQUE (email, organization_id)
      )
    `);

    // Ensure the stream column exists if the table was already created
    await client.query(`
      ALTER TABLE students ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS password VARCHAR(255);
      ALTER TABLE students ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS otp_code VARCHAR(6);
      ALTER TABLE students ADD COLUMN IF NOT EXISTS otp_expiry TIMESTAMPTZ;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS stream VARCHAR(50);
    `);

    await client.query(`
      ALTER TABLE students ADD COLUMN IF NOT EXISTS image_url TEXT;
    `);

    await client.query(`
      ALTER TABLE students ADD COLUMN IF NOT EXISTS cloudinary_id VARCHAR(255);
      ALTER TABLE students ADD COLUMN IF NOT EXISTS push_token VARCHAR(255);
      ALTER TABLE students ADD COLUMN IF NOT EXISTS angle_images JSONB DEFAULT '{}'::jsonb;
    `);

    // Multi-angle face embeddings: stores array of 512-d vectors [[front],[left],[right],[down]]
    await client.query(`
      ALTER TABLE students ADD COLUMN IF NOT EXISTS face_embeddings JSONB;
    `);

    await client.query(`
      ALTER TABLE students ADD COLUMN IF NOT EXISTS is_face_verified BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS subjects (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        code VARCHAR(50),
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE
      )
    `);

    // Add organization_id column and update constraints for subjects
    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subjects' AND column_name='organization_id') THEN
          ALTER TABLE subjects ADD COLUMN organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
        END IF;
        
        -- Drop old global unique constraint if it exists
        ALTER TABLE subjects DROP CONSTRAINT IF EXISTS subjects_name_key;
        
        -- Add new composite unique constraint
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subjects_name_org_key') THEN
          ALTER TABLE subjects ADD CONSTRAINT subjects_name_org_key UNIQUE (name, organization_id);
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS classrooms (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        camera_url VARCHAR(255) NOT NULL DEFAULT '0',
        camera_name VARCHAR(255),
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE
      )
    `);
    
    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='classrooms' AND column_name='organization_id') THEN
          ALTER TABLE classrooms ADD COLUMN organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='classrooms' AND column_name='camera_name') THEN
          ALTER TABLE classrooms ADD COLUMN camera_name VARCHAR(255);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='classrooms' AND column_name='camera_type') THEN
          ALTER TABLE classrooms ADD COLUMN camera_type VARCHAR(50) NOT NULL DEFAULT 'webcam';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='classrooms' AND column_name='camera_quality') THEN
          ALTER TABLE classrooms ADD COLUMN camera_quality VARCHAR(20) NOT NULL DEFAULT '720p';
        END IF;

        -- Drop old global unique constraint if it exists
        ALTER TABLE classrooms DROP CONSTRAINT IF EXISTS classrooms_name_key;

        -- Add new composite unique constraint
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classrooms_name_org_key') THEN
          ALTER TABLE classrooms ADD CONSTRAINT classrooms_name_org_key UNIQUE (name, organization_id);
        END IF;

        -- Drop old global unique constraint for cameras if it exists
        ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_camera_url_key;

        -- Add new composite unique constraint for cameras
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cameras_camera_url_org_key') THEN
          ALTER TABLE cameras ADD CONSTRAINT cameras_camera_url_org_key UNIQUE (camera_url, organization_id);
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
        classroom_id INTEGER REFERENCES classrooms(id) ON DELETE SET NULL,
        teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'scheduled', 'ended', 'cancelled'))
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'sessions_status_check'
        ) THEN
          ALTER TABLE sessions DROP CONSTRAINT sessions_status_check;
        END IF;
        ALTER TABLE sessions
          ADD CONSTRAINT sessions_status_check
          CHECK (status IN ('active', 'scheduled', 'ended', 'cancelled'));
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent')),
        marked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (student_id, session_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS recheck_requests (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schedules (
        id SERIAL PRIMARY KEY,
        subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        classroom_id INTEGER NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
        teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        day_of_week VARCHAR(20) NOT NULL CHECK (day_of_week IN ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')),
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        year VARCHAR(1) NOT NULL DEFAULT '1' CHECK (year IN ('1', '2', '3', '4')),
        stream VARCHAR(50) NOT NULL DEFAULT 'CSE',
        camera_id VARCHAR(50) NOT NULL DEFAULT '0'
      )
    `);

    await client.query(`
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    `);

    await client.query(`
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS valid_from DATE NOT NULL DEFAULT '1970-01-01';
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS valid_until DATE;
      ALTER TABLE schedules ALTER COLUMN valid_from SET DEFAULT CURRENT_DATE;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cancelled_classes (
        id SERIAL PRIMARY KEY,
        schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        cancel_date DATE NOT NULL DEFAULT CURRENT_DATE,
        UNIQUE (schedule_id, cancel_date)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS timetable_week_entries (
        id SERIAL PRIMARY KEY,
        week_start DATE NOT NULL,
        entry_date DATE,
        source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('regular', 'custom')),
        source_id INTEGER,
        action VARCHAR(20) NOT NULL CHECK (action IN ('active', 'cancelled', 'deleted')),
        subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
        classroom_id INTEGER REFERENCES classrooms(id) ON DELETE SET NULL,
        teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        day_of_week VARCHAR(20) NOT NULL CHECK (day_of_week IN ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')),
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        year VARCHAR(1) NOT NULL DEFAULT '1' CHECK (year IN ('1', '2', '3', '4')),
        stream VARCHAR(50) NOT NULL DEFAULT 'CSE',
        camera_id VARCHAR(50) NOT NULL DEFAULT '0',
        camera_name VARCHAR(255),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      ALTER TABLE timetable_week_entries ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'timetable_week_entries_action_check'
        ) THEN
          ALTER TABLE timetable_week_entries DROP CONSTRAINT timetable_week_entries_action_check;
        END IF;
        ALTER TABLE timetable_week_entries
          ADD CONSTRAINT timetable_week_entries_action_check
          CHECK (action IN ('active', 'cancelled', 'deleted'));
      END $$;
    `);

    // Modify global unique constraint on users and students emails
    await client.query(`
        DO $$
        BEGIN
          -- Drop old global unique constraint for users email
          ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
          
          -- Add composite unique constraint for users email and org
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_email_org_key') THEN
            ALTER TABLE users ADD CONSTRAINT users_email_org_key UNIQUE (email, organization_id);
          END IF;

          -- Drop old global unique constraint for students email, roll_number, and roll_number_college_id
          ALTER TABLE students DROP CONSTRAINT IF EXISTS students_email_key;
          ALTER TABLE students DROP CONSTRAINT IF EXISTS students_roll_number_key;
          ALTER TABLE students DROP CONSTRAINT IF EXISTS students_roll_number_college_id_key;
          
          -- Add composite unique constraint for students email and org
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'students_email_org_key') THEN
            ALTER TABLE students ADD CONSTRAINT students_email_org_key UNIQUE (email, organization_id);
          END IF;

          -- Add composite unique constraint for students roll_number, college_id, and org
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'students_roll_college_org_key') THEN
            ALTER TABLE students ADD CONSTRAINT students_roll_college_org_key UNIQUE (roll_number, college_id, organization_id);
          END IF;
        END $$;
    `);

    // Ensure the stream column exists in schedules if the table was already created
    await client.query(`
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS stream VARCHAR(50) NOT NULL DEFAULT 'CSE';
    `);

    await client.query(`
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS is_custom BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    await client.query(`
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS year INTEGER;
    `);

    await client.query(`
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS stream VARCHAR(50);
    `);

    await client.query(`
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL;
    `);

    // ── MULTI-CAMERA AND MULTI-CLASSROOM SUPPORT ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS cameras (
        id SERIAL PRIMARY KEY,
        classroom_id INTEGER NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
        camera_url VARCHAR(255) UNIQUE NOT NULL,
        camera_name VARCHAR(255),
        camera_type VARCHAR(50) NOT NULL DEFAULT 'webcam',
        camera_quality VARCHAR(20) NOT NULL DEFAULT '720p',
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schedule_classrooms (
        schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        classroom_id INTEGER NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
        PRIMARY KEY (schedule_id, classroom_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS session_classrooms (
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        classroom_id INTEGER NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
        PRIMARY KEY (session_id, classroom_id)
      );
    `);

    // Migrate existing cameras from classrooms table to cameras table
    await client.query(`
      INSERT INTO cameras (classroom_id, camera_url, camera_name, camera_type, camera_quality, organization_id)
      SELECT id, camera_url, camera_name, camera_type, camera_quality, organization_id FROM classrooms
      ON CONFLICT (camera_url, organization_id) DO NOTHING;
    `);

    // Migrate existing classroom assignments from schedules table
    await client.query(`
      INSERT INTO schedule_classrooms (schedule_id, classroom_id)
      SELECT id, classroom_id FROM schedules
      ON CONFLICT DO NOTHING;
    `);

    // Migrate existing classroom assignments from sessions table
    await client.query(`
      INSERT INTO session_classrooms (session_id, classroom_id)
      SELECT id, classroom_id FROM sessions WHERE classroom_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    `);


    await client.query(`
      CREATE TABLE IF NOT EXISTS time_slots (
        id SERIAL PRIMARY KEY,
        start_time VARCHAR(20) NOT NULL,
        end_time VARCHAR(20) NOT NULL,
        raw_start VARCHAR(20) NOT NULL,
        raw_end VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      ALTER TABLE time_slots ADD COLUMN IF NOT EXISTS valid_from DATE NOT NULL DEFAULT '1970-01-01';
      ALTER TABLE time_slots ADD COLUMN IF NOT EXISTS valid_until DATE;
      ALTER TABLE time_slots ALTER COLUMN valid_from SET DEFAULT CURRENT_DATE;
    `);

    // Check if time_slots has values, otherwise insert defaults
    const slotCountRes = await client.query('SELECT COUNT(*) FROM time_slots');
    if (parseInt(slotCountRes.rows[0].count) === 0) {
      const defaultSlots = [
        ['10:15 AM', '11:05 AM', '10:15:00', '11:05:00'],
        ['11:05 AM', '11:55 AM', '11:05:00', '11:55:00'],
        ['11:55 AM', '12:45 PM', '11:55:00', '12:45:00'],
        ['12:45 PM', '01:35 PM', '12:45:00', '13:35:00'],
        ['01:35 PM', '02:25 PM', '13:35:00', '14:25:00'],
        ['02:25 PM', '03:15 PM', '14:25:00', '15:15:00'],
        ['03:15 PM', '04:05 PM', '15:15:00', '16:05:00'],
        ['04:05 PM', '04:55 PM', '16:05:00', '16:55:00'],
        ['04:55 PM', '05:45 PM', '16:55:00', '17:45:00']
      ];

      for (const slot of defaultSlots) {
        await client.query(
          'INSERT INTO time_slots (start_time, end_time, raw_start, raw_end) VALUES ($1, $2, $3, $4)',
          slot
        );
      }
    }

    // Removed default subject/classroom seeding


    // --- SEED ORGANIZATIONS (DEPRECATED: Now uses Global Master List) ---

    // ── ONE-TIME CLEANUP: Remove duplicate active sessions caused by timezone bug ──
    // Keeps only the most recently created active session per subject+classroom per day
    const { rowCount: dupsRemoved } = await client.query(`
      UPDATE sessions SET status = 'ended'
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY subject_id, classroom_id, (start_time AT TIME ZONE 'Asia/Kolkata')::date
              ORDER BY id DESC  -- keep the most recent (highest id)
            ) AS rn
          FROM sessions
          WHERE status = 'active' AND is_custom = false
        ) ranked
        WHERE rn > 1  -- end all but the most recent duplicate
      )
    `);
    if (dupsRemoved > 0) {
      console.log(`✅ Cleanup: Ended ${dupsRemoved} duplicate active session(s).`);

    }

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
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS class_requests (
        id SERIAL PRIMARY KEY,
        schedule_id INTEGER REFERENCES schedules(id) ON DELETE CASCADE,
        session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
        requester_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        target_teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        request_type VARCHAR(50) NOT NULL CHECK (request_type IN ('cancel', 'handover')),
        status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        reason TEXT,
        request_date DATE NOT NULL,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS class_notes (
        id SERIAL PRIMARY KEY,
        schedule_id INTEGER REFERENCES schedules(id) ON DELETE CASCADE,
        session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
        teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        file_url VARCHAR(255) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        upload_date DATE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Chatting (Node) System Tables
      CREATE TABLE IF NOT EXISTS chat_groups (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
        year INTEGER NOT NULL,
        stream VARCHAR(100) NOT NULL,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chat_group_members (
        id SERIAL PRIMARY KEY,
        group_id INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE,
        teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK ((teacher_id IS NOT NULL AND student_id IS NULL) OR (teacher_id IS NULL AND student_id IS NOT NULL))
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        group_id INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE,
        sender_teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        sender_student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        attachment_url VARCHAR(255),
        is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK ((sender_teacher_id IS NOT NULL AND sender_student_id IS NULL) OR (sender_teacher_id IS NULL AND sender_student_id IS NOT NULL))
      );
      
      CREATE INDEX IF NOT EXISTS idx_chat_messages_group_id ON chat_messages(group_id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);
    `);

    await client.query('COMMIT');

    console.log('Database tables initialized successfully.');
    client.release();
    process.exit(0);
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Error initializing database:', err);
    client?.release();
    process.exit(1);
  }
};

initDb();
