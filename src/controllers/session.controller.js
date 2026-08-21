import pool from '../config/database.config.js';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import { sendDirectNotification, sendCohortNotification, sendRoleNotification } from '../services/notification.service.js';

// ── Helper: Extract date/time parts in India Standard Time ──────────────────
const getISTParts = (date = new Date()) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = formatter.formatToParts(date);
  const getVal = (type) => parts.find(p => p.type === type).value;
  return {
    day: getVal('weekday'),
    dateStr: `${getVal('year')}-${getVal('month')}-${getVal('day')}`,
    timeHM: `${getVal('hour')}:${getVal('minute')}`,
    timeHMS: `${getVal('hour')}:${getVal('minute')}:${getVal('second')}`
  };
};

const getCurrentWeekRange = (value = null) => {
  let baseDate;
  if (value) {
    baseDate = new Date(`${value}T00:00:00+05:30`);
  } else {
    baseDate = new Date();
  }
  
  const dayName = getISTParts(baseDate).day;
  const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const day = daysOfWeek.indexOf(dayName);
  
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  
  const { dateStr } = getISTParts(baseDate);
  const istMidnight = new Date(`${dateStr}T00:00:00+05:30`);
  
  const monday = new Date(istMidnight.getTime() + diffToMonday * 24 * 60 * 60 * 1000);
  const sunday = new Date(monday.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
  
  return { startOfWeek: monday, endOfWeek: sunday };
};

// ── Helper: Finalize Session (Mark ended and fill absent records) ──────────────
export const finalizeSession = async (sessionId, io = null) => {
  try {
    console.log(`[Finalizer] Finalizing session ID: ${sessionId}`);
    
    // 1. Mark session as ended
    const { rows: sessions } = await pool.query(
      "UPDATE sessions SET status = 'ended' WHERE id = $1 RETURNING *",
      [sessionId]
    );
    
    if (sessions.length === 0) return;
    const session = sessions[0];

    // Get orgId from session_classrooms junction (multi-classroom support)
    const { rows: sessionClassrooms } = await pool.query(
      `SELECT c.organization_id FROM session_classrooms sc
       JOIN classrooms c ON sc.classroom_id = c.id
       WHERE sc.session_id = $1 LIMIT 1`,
      [sessionId]
    );
    // Fallback to legacy classroom_id if no junction rows exist
    let orgId = sessionClassrooms[0]?.organization_id;
    if (!orgId && session.classroom_id) {
      const { rows: fallbackClassrooms } = await pool.query(
        "SELECT organization_id FROM classrooms WHERE id = $1",
        [session.classroom_id]
      );
      orgId = fallbackClassrooms[0]?.organization_id;
    }
    
    // 2. Identify students who should have been present (Roster)
    if (session.year && session.stream) {
      const { rows: roster } = await pool.query(
        "SELECT id FROM students WHERE year::text = $1::text AND LOWER(stream) = LOWER($2) AND status = 'active'",
        [session.year, session.stream]
      );
      
      if (roster.length > 0) {
        // 3. Mark all missing students as 'absent'
        // ON CONFLICT DO NOTHING ensures we don't overwrite 'present' records
        const valueStrings = roster.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(',');
        const flatValues = roster.flatMap(s => [s.id, sessionId, 'absent']);
        
        await pool.query(`
          INSERT INTO attendance (student_id, session_id, status)
          VALUES ${valueStrings}
          ON CONFLICT (student_id, session_id) DO NOTHING
        `, flatValues);
        
        console.log(`[Finalizer] Session ${sessionId} finalized. Roster size: ${roster.length}. Attendance state preserved.`);

        // 4. Dispatch Grouped & Direct Finalized Attendance Notifications
        const { rows: attRows } = await pool.query(`
          SELECT a.student_id, a.status, sub.name as subject_name, c.name as classroom_name, s.organization_id
          FROM attendance a
          JOIN sessions sess ON a.session_id = sess.id
          LEFT JOIN subjects sub ON sess.subject_id = sub.id
          LEFT JOIN classrooms c ON sess.classroom_id = c.id
          JOIN students s ON a.student_id = s.id
          WHERE a.session_id = $1
        `, [sessionId]);

        let presentCount = 0;
        let absentCount = 0;

        for (const att of attRows) {
          if (att.status === 'present') presentCount++;
          else absentCount++;

          const msg = att.status === 'present' 
            ? `You were marked PRESENT in ${att.subject_name || 'Class'} at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`
            : `You were marked ABSENT in ${att.subject_name || 'Class'}.`;

          sendDirectNotification({
            receiver_id: att.student_id,
            receiver_role: 'student',
            type: 'attendance',
            session_type: session.is_custom ? 'custom' : 'regular',
            priority: 'important',
            title: att.status === 'present' ? 'Attendance Marked: Present' : 'Attendance Marked: Absent',
            message: msg,
            metadata: { session_id: sessionId, subject_name: att.subject_name, status: att.status },
            redirect_url: `/sessions`,
            organization_id: att.organization_id,
            expires_in_days: 90
          });
        }

        if (session.teacher_id && attRows.length > 0) {
          const orgId = attRows[0].organization_id;
          const summaryMsg = `Session Finalized: ${attRows[0].subject_name || 'Class'}. ${presentCount} Present, ${absentCount} Absent.`;
          sendDirectNotification({
            receiver_id: session.teacher_id,
            receiver_role: 'teacher',
            type: 'attendance',
            session_type: session.is_custom ? 'custom' : 'regular',
            priority: 'important',
            title: 'Session Finalized',
            message: summaryMsg,
            metadata: { session_id: sessionId, present_count: presentCount, absent_count: absentCount },
            redirect_url: `/sessions`,
            organization_id: orgId,
            expires_in_days: 90
          });
          sendRoleNotification({
            role: 'admin',
            organization_id: orgId,
            type: 'attendance',
            session_type: session.is_custom ? 'custom' : 'regular',
            priority: 'important',
            title: 'Session Finalized',
            message: summaryMsg,
            metadata: { session_id: sessionId, present_count: presentCount, absent_count: absentCount },
            redirect_url: `/sessions`,
            expires_in_days: 90
          });
        }
      }
    }
    
    if (io) {
      if (orgId) {
        io.to(`org_${orgId}`).emit('session_ended', { id: sessionId, organization_id: orgId });
      } else {
        io.emit('session_ended', { id: sessionId });
      }
    }

    // Trigger AI service to refresh and potentially release cameras immediately
    axios.post(`${process.env.AI_SERVICE_URL || 'http://localhost:8001'}/system/refresh`)
      .catch(e => console.warn(`[Finalizer] AI Refresh failed for session ${sessionId}`));

    return true;
  } catch (err) {
    console.error(`[Finalizer Error] Session ${sessionId}:`, err.message);
    return false;
  }
};

export const startSession = async (req, res) => {
  const { subject_id, duration, year, stream } = req.body;
  const teacher_id = req.body.teacher_id || req.user?.id;

  let classroomIds = req.body.classroom_ids;
  if (!classroomIds && req.body.classroom_id) {
    classroomIds = [parseInt(req.body.classroom_id, 10)];
  }

  if (!classroomIds || !Array.isArray(classroomIds) || classroomIds.length === 0) {
    return res.status(400).json({ message: 'At least one classroom is required' });
  }

  const primary_classroom_id = classroomIds[0];

  try {
    if (!req.body.start_time || !req.body.end_time) {
      return res.status(400).json({
        message: 'Start time and end time are required to schedule a custom session.'
      });
    }

    const start_time = new Date(req.body.start_time);
    const end_time = new Date(req.body.end_time);

    if (isNaN(start_time.getTime()) || isNaN(end_time.getTime())) {
      return res.status(400).json({
        message: 'Invalid start time or end time format provided.'
      });
    }
    
    // Day of the week and dates in IST
    const startIST = getISTParts(start_time);
    const endIST = getISTParts(end_time);
    const sessionDay = startIST.day;
    const startStr = startIST.timeHMS;
    const endStr = endIST.timeHMS;
    const sessionDateStr = startIST.dateStr;

    // 0. Validation: Cannot add a session that has already passed
    const now_ts = new Date();
    if (now_ts > end_time) {
      return res.status(400).json({
        message: 'The selected time has already passed. Please choose another time slot for today or a future date.'
      });
    }

    // 1. Check for overlapping custom sessions (active or scheduled)
    const { rows: overlappingSessions } = await pool.query(`
      SELECT s.*, sub.name as subject_name, sc.classroom_id as col_classroom_id FROM sessions s
      JOIN subjects sub ON s.subject_id = sub.id
      LEFT JOIN session_classrooms sc ON s.id = sc.session_id
      WHERE (
          (sc.classroom_id = ANY($1) OR s.classroom_id = ANY($1)) OR 
          s.teacher_id = $2 OR 
          (s.year = $3 AND s.stream = $4)
        )
        AND s.start_time < ($5::timestamptz - interval '1 second')
        AND s.end_time > ($6::timestamptz + interval '1 second')
        AND s.status IN ('active', 'scheduled')
    `, [classroomIds, teacher_id, year ? parseInt(year, 10) : null, stream, end_time, start_time]);

    if (overlappingSessions.length > 0) {
      const collision = overlappingSessions[0];
      let reason = 'Student Group (Year/Stream)';

      if (collision.col_classroom_id && classroomIds.includes(parseInt(collision.col_classroom_id))) {
        reason = 'Classroom';
      } else if (collision.teacher_id === parseInt(teacher_id)) {
        reason = 'Teacher';
      }

      return res.status(400).json({
        message: `Conflict! ${reason} is already occupied by ${collision.subject_name} (Year ${collision.year || 'N/A'}) during this time.`
      });
    }

    // 2. Check for collisions with Regular Schedules (Routine) for THAT SPECIFIC DAY
    // We ignore routine slots that are officially CANCELLED for this specific date
    const { rows: routineCollisions } = await pool.query(`
      SELECT s.*, sub.name as subject_name, sc.classroom_id as col_classroom_id FROM schedules s
      JOIN subjects sub ON s.subject_id = sub.id
      LEFT JOIN schedule_classrooms sc ON s.id = sc.schedule_id
      LEFT JOIN cancelled_classes cc ON s.id = cc.schedule_id AND cc.cancel_date = $7::date
      WHERE s.day_of_week = $1
        AND s.start_time < $8::time AND s.end_time > $2::time
        AND (sc.classroom_id = ANY($3) OR s.classroom_id = ANY($3) OR s.teacher_id = $4 OR (s.year = $5 AND s.stream = $6))
        AND cc.id IS NULL
        AND s.valid_from <= $7::date
        AND (s.valid_until IS NULL OR $7::date < s.valid_until)
        AND NOT EXISTS (
          SELECT 1 FROM timetable_week_entries twe
          WHERE twe.source_id = s.id
            AND twe.source_type = 'regular'
            AND twe.entry_date = $7::date
            AND twe.action IN ('cancelled', 'deleted')
        )
    `, [sessionDay, startStr, classroomIds, teacher_id, year, stream, sessionDateStr, endStr]);

    if (routineCollisions.length > 0) {
      const collision = routineCollisions[0];
      let reason = 'Student Group';
      if (collision.col_classroom_id && classroomIds.includes(parseInt(collision.col_classroom_id))) reason = 'Classroom';
      if (collision.teacher_id === parseInt(teacher_id)) reason = 'Teacher';

      return res.status(400).json({
        message: `Routine Conflict! ${reason} is already occupied by the Year ${collision.year} ${collision.stream} class (${collision.subject_name}) according to the weekly routine.`
      });
    }

    // Determine status: active if now is within window, scheduled if future
    let status = 'active';
    if (now_ts < start_time) {
      status = 'scheduled';
    }

    const result = await pool.query(
      'INSERT INTO sessions (subject_id, classroom_id, teacher_id, start_time, end_time, status, year, stream, is_custom) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
      [subject_id, primary_classroom_id, teacher_id, start_time, end_time, status, year || null, stream || null, true]
    );
    const sessionId = result.rows[0].id;

    // Insert into session_classrooms junction table
    for (const rId of classroomIds) {
      await pool.query(
        'INSERT INTO session_classrooms (session_id, classroom_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [sessionId, rId]
      );
    }

    // Fetch names for the broadcast
    const { rows: meta } = await pool.query(`
      SELECT sub.name as subject_name, c.name as classroom_name, c.camera_name, c.camera_url, c.camera_type, c.camera_quality, u.name as teacher_name, u.image_url as teacher_image, u.organization_id
      FROM subjects sub, classrooms c, users u
      WHERE sub.id = $1 AND c.id = $2 AND u.id = $3
    `, [subject_id, primary_classroom_id, teacher_id]);

    const io = req.app.get('io');
    const orgId = meta[0]?.organization_id;
    const payload = {
      id: sessionId,
      subject_id,
      classroom_id: primary_classroom_id,
      teacher_id,
      start_time,
      end_time,
      year,
      stream,
      is_custom: true,
      status,
      subject_name: meta[0]?.subject_name,
      classroom_name: meta[0]?.classroom_name,
      camera_name: meta[0]?.camera_name,
      camera_url: meta[0]?.camera_url,
      camera_type: meta[0]?.camera_type,
      camera_quality: meta[0]?.camera_quality,
      teacher_name: meta[0]?.teacher_name,
      organization_id: orgId
    };

    if (io) {
      if (orgId) {
        io.to(`org_${orgId}`).emit('session_started', payload);
      } else {
        io.emit('session_started', payload);
      }
    }

    // Notify AI service to refresh and start scanning immediately
    axios.post(`${process.env.AI_SERVICE_URL || 'http://localhost:8001'}/system/refresh`).catch(e => console.warn('AI Refresh failed on session start'));

    if (meta[0] && year && stream) {
      const orgId = meta[0].organization_id;
      const notifTitle = 'Custom Class Scheduled';
      const notifMsg = `${meta[0].teacher_name} added a custom ${meta[0].subject_name} class for Year ${year} ${stream} at ${new Date(start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} in ${meta[0].classroom_name}.`;
      const notifMeta = { year, stream, session_id: sessionId, subject_name: meta[0].subject_name, week_start: new Date(start_time).toISOString().split('T')[0] };
      const notifUrl = `/routine?week_start=${notifMeta.week_start}&highlight=${sessionId}`;

      sendCohortNotification({
        organization_id: orgId,
        year,
        stream,
        sender_id: teacher_id,
        sender_name: meta[0].teacher_name,
        sender_image: meta[0].teacher_image,
        type: 'custom-session',
        session_type: 'custom',
        priority: 'important',
        title: notifTitle,
        message: notifMsg,
        metadata: notifMeta,
        redirect_url: notifUrl,
        expires_in_days: 60
      });

      sendRoleNotification({
        role: 'admin',
        organization_id: orgId,
        sender_id: teacher_id,
        sender_name: meta[0].teacher_name,
        sender_image: meta[0].teacher_image,
        type: 'custom-session',
        session_type: 'custom',
        priority: 'important',
        title: notifTitle,
        message: notifMsg,
        metadata: notifMeta,
        redirect_url: notifUrl,
        expires_in_days: 60
      });
    }

    res.status(201).json({ message: 'Custom session added successfully', sessionId });
  } catch (err) {
    console.error('Session Start Error:', err.message);
    res.status(500).json({ message: err.message });
  }
};

export const endSession = async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ message: 'Session ID is required' });

  try {
    console.log(`[EndSession] Marking session ID ${id} as ended`);

    const result = await finalizeSession(id, req.app.get('io'));

    if (!result) {
      return res.status(404).json({ message: 'Session not found or already finalized' });
    }

    // 2. Immediate Broadcast to Dashboard
    const io = req.app.get('io');
    if (io) {
      io.emit('session_ended', { id });
    }

    res.json({ message: 'Session ended', id });
  } catch (err) {
    console.error('[EndSession Error]:', err.message);
    res.status(500).json({ message: err.message });
  }
};

export const endBySchedule = async (req, res) => {
  let { schedule_id } = req.body;
  if (String(schedule_id).startsWith('routine_')) schedule_id = schedule_id.replace('routine_', '');
  try {
    console.log(`[DeepDelete] Physically removing all sessions for schedule: ${schedule_id}`);

    // Hard delete any active sessions for this schedule
    const { rows: deleted } = await pool.query(
      "DELETE FROM sessions WHERE schedule_id = $1 RETURNING id",
      [schedule_id]
    );

    // Call finalizer for each session to ensure attendance is saved before "removal"
    for (const sess of deleted) {
      await finalizeSession(sess.id, io);
    }

    res.json({ message: 'Sessions marked as ended and finalized', count: deleted.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const cancelSession = async (req, res) => {
  let { id, password } = req.body;
  if (String(id).startsWith('db_')) id = id.replace('db_', '');
  if (String(id).startsWith('routine_')) id = id.replace('routine_', '');
  const teacher_id = req.user.id;
  try {
    const sessionId = parseInt(id);
    const { rows } = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    
    if (rows.length === 0) return res.status(404).json({ message: 'Session not found' });
    const session = rows[0];

    // Only custom sessions can be cancelled via this endpoint
    if (!session.is_custom) {
      return res.status(400).json({ message: 'Only custom sessions can be cancelled this way.' });
    }

    // RESTRICTION: Future Week Delete Logic
    const { startOfWeek, endOfWeek } = getCurrentWeekRange();
    const sessionStart = new Date(session.start_time);
    
    if (sessionStart > endOfWeek && req.user?.role !== 'admin') {
      return res.status(400).json({ 
        message: 'This session belongs to a future week and cannot be deleted until that week becomes active.' 
      });
    }

    // Verify password
    const { rows: users } = await pool.query('SELECT password FROM users WHERE id = $1', [teacher_id]);
    if (users.length === 0) return res.status(404).json({ message: 'User not found' });
    
    const isMatch = await bcrypt.compare(password, users[0].password);
    if (!isMatch) {
      return res.status(403).json({ message: 'Invalid password. Cancellation denied.' });
    }

    // Mark custom session as 'cancelled' (not just physical delete)
    await pool.query("UPDATE sessions SET status = 'cancelled' WHERE id = $1", [sessionId]);

    if (session.year && session.stream) {
      const { rows: roster } = await pool.query(
        "SELECT id FROM students WHERE year::text = $1::text AND LOWER(stream) = LOWER($2) AND status = 'active'",
        [session.year, session.stream]
      );
      if (roster.length > 0) {
        const valueStrings = roster.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(',');
        const flatValues = roster.flatMap(s => [s.id, sessionId, 'absent']);
        await pool.query(`
          INSERT INTO attendance (student_id, session_id, status)
          VALUES ${valueStrings}
          ON CONFLICT (student_id, session_id) DO NOTHING
        `, flatValues);
      }
    }

    const io = req.app.get('io');
    if (io) io.emit('session_ended', { id: sessionId });

    if (session.subject_id && session.classroom_id) {
      const { rows: meta } = await pool.query(
        `SELECT sub.name as subject_name, c.name as classroom_name, c.organization_id 
         FROM subjects sub, classrooms c 
         WHERE sub.id = $1 AND c.id = $2`,
        [session.subject_id, session.classroom_id]
      );

      if (meta[0] && session.year && session.stream) {
        const orgId = meta[0].organization_id;
        const notifTitle = 'Class Cancelled';
        const notifMsg = `The custom ${meta[0].subject_name} class scheduled for ${new Date(session.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} in ${meta[0].classroom_name} has been cancelled.`;
        const notifMeta = { year: session.year, stream: session.stream, session_id: sessionId, subject_name: meta[0].subject_name, week_start: new Date(session.start_time).toISOString().split('T')[0] };
        const notifUrl = `/routine?week_start=${notifMeta.week_start}&highlight=${sessionId}`;

        sendCohortNotification({
          organization_id: orgId,
          year: session.year,
          stream: session.stream,
          sender_id: teacher_id,
          sender_name: req.user?.name || 'Faculty',
          type: 'cancelled-session',
          session_type: 'cancelled',
          priority: 'critical',
          title: notifTitle,
          message: notifMsg,
          metadata: notifMeta,
          redirect_url: notifUrl,
          expires_in_days: 60
        });

        sendRoleNotification({
          role: 'admin',
          organization_id: orgId,
          sender_id: teacher_id,
          sender_name: req.user?.name || 'Faculty',
          type: 'cancelled-session',
          session_type: 'cancelled',
          priority: 'critical',
          title: notifTitle,
          message: notifMsg,
          metadata: notifMeta,
          redirect_url: notifUrl,
          expires_in_days: 60
        });
      }
    }

    res.json({ message: 'Custom class cancelled successfully' });
  } catch (err) {
    console.error('[cancelSession Error]:', err.message);
    res.status(500).json({ message: err.message });
  }
};

export const getSessions = async (req, res) => {
  const { year, stream, allCustom, week_start } = req.query;

  try {
    // 1. Get current IST context for virtual routine generation
    const now = new Date();
    const istContext = getISTParts(now);
    const istDateStr = istContext.dateStr;
    const currentDay = istContext.day;
    const currentTimeHM = istContext.timeHM;

    const organization_id = req.user?.organization_id || req.query.organization_id;
    if (!organization_id) {
        return res.status(400).json({ message: 'Organization context missing' });
    }

    // ── STEP 1: Fetch Real Database Sessions ──
    const { startOfWeek, endOfWeek } = getCurrentWeekRange(week_start);
    const customDateClause = allCustom === 'true' ? `TRUE` : `s.start_time >= $1 AND s.start_time <= $2`; 
    const statusClause = allCustom === 'true' || week_start
      ? `s.status IN ('active', 'scheduled', 'ended', 'cancelled')`
      : `s.status IN ('active', 'scheduled', 'ended', 'cancelled')`;
    
    // We filter by organization_id to ensure isolation between different colleges
    let sessionParams = [startOfWeek, endOfWeek, organization_id];
    let sessionQuery = `
      SELECT s.id, s.subject_id, s.teacher_id, s.classroom_id, s.status, s.year, s.stream, s.is_custom, s.schedule_id,
             s.start_time, s.end_time,
             sub.name as subject_name, c.camera_url, c.camera_name, c.camera_type, c.camera_quality, c.name as classroom_name, u.name as teacher_name, u.is_active as teacher_is_active
       FROM sessions s
       LEFT JOIN subjects sub ON s.subject_id = sub.id
       LEFT JOIN classrooms c ON s.classroom_id = c.id
       LEFT JOIN users u ON s.teacher_id = u.id
       WHERE (
         (s.is_custom = false AND ${statusClause} AND s.start_time >= $1 AND s.start_time <= $2)
         OR
         (s.is_custom = true AND ${statusClause} AND ${customDateClause})
       )
       AND c.organization_id = $3
     `;
    

    if (year) { sessionParams.push(String(year)); sessionQuery += ` AND s.year::text = $${sessionParams.length}`; }
    if (stream) { sessionParams.push(String(stream)); sessionQuery += ` AND s.stream ILIKE $${sessionParams.length}`; }

    const { rows: dbSessions } = await pool.query(sessionQuery, sessionParams);

    // ── Enrich DB sessions with multi-classroom + camera data ──
    for (const sess of dbSessions) {
      const { rows: scRows } = await pool.query(`
        SELECT c.id, c.name, c.camera_url, c.camera_name, c.camera_type, c.camera_quality
        FROM session_classrooms sc
        JOIN classrooms c ON sc.classroom_id = c.id
        WHERE sc.session_id = $1
      `, [sess.id]);
      // Fetch cameras for each classroom
      const classroomsWithCameras = [];
      for (const cr of scRows) {
        const { rows: cams } = await pool.query(`
          SELECT id, camera_url, camera_name, camera_type, camera_quality
          FROM cameras WHERE classroom_id = $1
        `, [cr.id]);
        classroomsWithCameras.push({ ...cr, cameras: cams });
      }
      // Fallback: if no junction rows, use legacy classroom_id
      if (classroomsWithCameras.length === 0 && sess.classroom_id) {
        const { rows: cams } = await pool.query(`
          SELECT id, camera_url, camera_name, camera_type, camera_quality
          FROM cameras WHERE classroom_id = $1
        `, [sess.classroom_id]);
        classroomsWithCameras.push({
          id: sess.classroom_id,
          name: sess.classroom_name,
          camera_url: sess.camera_url,
          camera_name: sess.camera_name,
          camera_type: sess.camera_type,
          camera_quality: sess.camera_quality,
          cameras: cams.length > 0 ? cams : [{ camera_url: sess.camera_url, camera_name: sess.camera_name, camera_type: sess.camera_type, camera_quality: sess.camera_quality }]
        });
      }
      sess.classrooms = classroomsWithCameras;
      // Update classroom_name to aggregated names for backwards compat
      if (classroomsWithCameras.length > 1) {
        sess.classroom_name = classroomsWithCameras.map(c => c.name).join(', ');
      }
    }

    // ── STEP 2: Fetch Today's Routine (virtual sessions for UI) ──
    let scheduleQuery = `
      SELECT s.*, sub.name as subject_name, c.name as classroom_name, c.camera_name, c.camera_url, c.camera_type, c.camera_quality, u.name as teacher_name, u.is_active as teacher_is_active
      FROM schedules s
      JOIN subjects sub ON s.subject_id = sub.id
      LEFT JOIN classrooms c ON s.classroom_id = c.id
      LEFT JOIN users u ON s.teacher_id = u.id
      WHERE s.day_of_week = $1 
        AND s.organization_id = $2
        AND s.valid_from <= $3::date
        AND (s.valid_until IS NULL OR $3::date < s.valid_until)
        AND NOT EXISTS (
          SELECT 1 FROM timetable_week_entries t2
          WHERE t2.source_id = s.id 
            AND t2.source_type = 'regular'
            AND t2.entry_date = $3
            AND t2.action IN ('cancelled', 'deleted')
        )
    `;
    const scheduleParams = [currentDay, organization_id, istDateStr];
    if (year) { scheduleParams.push(String(year)); scheduleQuery += ` AND s.year::text = $${scheduleParams.length}`; }
    if (stream) { scheduleParams.push(String(stream)); scheduleQuery += ` AND s.stream ILIKE $${scheduleParams.length}`; }

    const { rows: todayRoutine } = await pool.query(scheduleQuery, scheduleParams);

    // Enrich routine schedules with multi-classroom + camera data
    for (const routine of todayRoutine) {
      const { rows: scRows } = await pool.query(`
        SELECT c.id, c.name, c.camera_url, c.camera_name, c.camera_type, c.camera_quality
        FROM schedule_classrooms sc
        JOIN classrooms c ON sc.classroom_id = c.id
        WHERE sc.schedule_id = $1
      `, [routine.id]);
      const classroomsWithCameras = [];
      for (const cr of scRows) {
        const { rows: cams } = await pool.query(`
          SELECT id, camera_url, camera_name, camera_type, camera_quality
          FROM cameras WHERE classroom_id = $1
        `, [cr.id]);
        classroomsWithCameras.push({ ...cr, cameras: cams });
      }
      // Fallback: if no junction rows, use legacy classroom_id
      if (classroomsWithCameras.length === 0 && routine.classroom_id) {
        const { rows: cams } = await pool.query(`
          SELECT id, camera_url, camera_name, camera_type, camera_quality
          FROM cameras WHERE classroom_id = $1
        `, [routine.classroom_id]);
        classroomsWithCameras.push({
          id: routine.classroom_id,
          name: routine.classroom_name,
          camera_url: routine.camera_url,
          camera_name: routine.camera_name,
          camera_type: routine.camera_type,
          camera_quality: routine.camera_quality,
          cameras: cams.length > 0 ? cams : [{ camera_url: routine.camera_url, camera_name: routine.camera_name, camera_type: routine.camera_type, camera_quality: routine.camera_quality }]
        });
      }
      routine._classrooms = classroomsWithCameras;
      if (classroomsWithCameras.length > 1) {
        routine.classroom_name = classroomsWithCameras.map(c => c.name).join(', ');
      }
    }

    // Convert Routine to Session format, deduplicating against real DB sessions
    const upcomingRoutine = todayRoutine
      .filter(routine => {
        // Filter out routine slots that already have a real DB session
        const alreadyExists = dbSessions.some(sess => {
          if (sess.is_custom) return false;
          
          // Match by subject and classroom
          if (sess.subject_id !== routine.subject_id) return false;
          if (sess.classroom_id !== routine.classroom_id) return false;

          // Match time using IST strings for reliable cross-timezone comparison
          const sessStartIST = getISTParts(new Date(sess.start_time)).timeHM;
          const routineStartHM = routine.start_time.substring(0, 5); // HH:MM
          
          // Check if HH:MM matches or is within a 2-minute drift
          const [sH, sM] = sessStartIST.split(':').map(Number);
          const [rH, rM] = routineStartHM.split(':').map(Number);
          
          const sMinutes = sH * 60 + sM;
          const rMinutes = rH * 60 + rM;

          return Math.abs(sMinutes - rMinutes) <= 2 && sess.status !== 'cancelled';
        });
        return !alreadyExists;
      })
      .map(routine => {
        const rStart = routine.start_time.substring(0, 5);
        const rEnd = routine.end_time.substring(0, 5);
        let status = 'scheduled';
        if (currentTimeHM >= rEnd) {
          status = 'ended';
        } else if (currentTimeHM >= rStart && currentTimeHM < rEnd) {
          status = 'active';
        }

        return {
          id: `routine_${routine.id}`,
          subject_id: routine.subject_id,
          classroom_id: routine.classroom_id,
          teacher_id: routine.teacher_id,
          subject_name: routine.subject_name,
          classroom_name: routine.classroom_name,
          teacher_name: routine.teacher_name,
          camera_name: routine.camera_name,
          camera_url: routine.camera_url,
          camera_type: routine.camera_type || 'webcam',
          camera_quality: routine.camera_quality || '720p',
          start_time: `${istDateStr}T${routine.start_time}+05:30`,
          end_time: `${istDateStr}T${routine.end_time}+05:30`,
          year: routine.year,
          stream: routine.stream,
          status,
          is_custom: false,
          classrooms: routine._classrooms || []
        };
      });

    const finalSessions = [...dbSessions, ...upcomingRoutine];

    // Sort: Active first, then Scheduled, then Ended, then Cancelled, and finally by start time
    finalSessions.sort((a, b) => {
      const order = { active: 0, scheduled: 1, ended: 2, cancelled: 3 };
      const rankA = order[a.status] ?? 9;
      const rankB = order[b.status] ?? 9;
      if (rankA !== rankB) return rankA - rankB;
      return String(a.start_time).localeCompare(String(b.start_time));
    });

    res.json(finalSessions);
  } catch (err) {
    console.error('[getSessions Error]:', err.message);
    res.status(500).json({ message: err.message });
  }
};

// Admin-only: Force delete any custom session regardless of week
export const deleteCustomSession = async (req, res) => {
  const { id } = req.params;
  try {
    const sessionId = parseInt(id);
    const { rows } = await pool.query('SELECT * FROM sessions WHERE id = $1 AND is_custom = true', [sessionId]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Custom session not found' });
    }

    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

    const io = req.app.get('io');
    if (io) io.emit('session_ended', { id: sessionId });

    console.log(`[AdminDelete] Custom session ${sessionId} force-deleted by admin.`);
    res.json({ message: 'Custom session permanently deleted', id: sessionId });
  } catch (err) {
    console.error('[deleteCustomSession Error]:', err.message);
    res.status(500).json({ message: err.message });
  }
};
