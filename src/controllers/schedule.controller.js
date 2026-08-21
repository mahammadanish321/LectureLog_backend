import pool from '../config/database.config.js';
import bcrypt from 'bcryptjs';
import { sendCohortNotification, sendRoleNotification } from '../services/notification.service.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

const toDateOnly = (date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const getVal = (type) => parts.find(p => p.type === type).value;
  return `${getVal('year')}-${getVal('month')}-${getVal('day')}`;
};

const getWeekStartDate = (value = null) => {
  let baseDate;
  if (value) {
    baseDate = new Date(`${value}T00:00:00+05:30`);
  } else {
    baseDate = new Date();
  }
  
  const dayName = getISTParts(baseDate).day;
  const day = DAYS.indexOf(dayName);
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  
  const { dateStr } = getISTParts(baseDate);
  const istMidnight = new Date(`${dateStr}T00:00:00+05:30`);
  
  const monday = new Date(istMidnight.getTime() + diffToMonday * 24 * 60 * 60 * 1000);
  return monday;
};

const getDateForDay = (weekStart, dayOfWeek) => {
  const idx = DAYS.indexOf(dayOfWeek);
  const diff = idx === 0 ? 6 : idx - 1;
  return new Date(weekStart.getTime() + diff * 24 * 60 * 60 * 1000);
};

const isFutureWeek = (weekStart) => {
  const currentWeekStart = getWeekStartDate();
  return weekStart.getTime() > currentWeekStart.getTime();
};

export const createSchedule = async (req, res) => {
  const { subject_id, day_of_week, start_time, end_time, teacher_id, year, camera_id, stream, week_start } = req.body;
  const creator_id = req.user.id;
  const final_teacher_id = teacher_id || creator_id;

  let classroomIds = req.body.classroom_ids;
  if (!classroomIds && req.body.classroom_id) {
    classroomIds = [parseInt(req.body.classroom_id, 10)];
  }

  if (!classroomIds || !Array.isArray(classroomIds) || classroomIds.length === 0) {
    return res.status(400).json({ message: 'At least one classroom is required' });
  }

  try {
    const targetWeekStart = getWeekStartDate(week_start);
    const targetWeekStartStr = toDateOnly(targetWeekStart);

    console.log('[createSchedule] Checking collisions for:', { day_of_week, start_time, end_time, classroomIds, final_teacher_id });
    
    // 1. Check for collisions in Regular Schedules (classroom, teacher, OR same year+stream)
    const { rows: routineCollisions } = await pool.query(`
      SELECT s.*, sub.name as subject_name, sc.classroom_id as col_classroom_id FROM schedules s
      JOIN subjects sub ON s.subject_id = sub.id
      LEFT JOIN schedule_classrooms sc ON s.id = sc.schedule_id
      WHERE s.day_of_week = $1 AND s.start_time::time < $7::time AND s.end_time::time > $2::time
      AND (sc.classroom_id = ANY($3) OR s.classroom_id = ANY($3) OR s.teacher_id = $4 OR (s.year = $5 AND s.stream = $6))
      AND (s.valid_until IS NULL OR (s.valid_until > $8::date AND NOT EXISTS (
        SELECT 1 FROM timetable_week_entries twe 
        WHERE twe.week_start = $8::date 
          AND twe.source_type = 'regular' 
          AND twe.source_id = s.id 
          AND twe.action = 'deleted'
      )))
    `, [day_of_week, start_time, classroomIds, final_teacher_id, year || '1', stream || 'CSE', end_time, targetWeekStartStr]);

    if (routineCollisions.length > 0) {
      const collision = routineCollisions[0];
      let reason = 'Student Group (Year/Stream)';
      if (collision.col_classroom_id && classroomIds.includes(parseInt(collision.col_classroom_id, 10))) {
        const { rows: cls } = await pool.query('SELECT name FROM classrooms WHERE id = $1', [collision.col_classroom_id]);
        reason = `Classroom '${cls[0]?.name || collision.col_classroom_id}'`;
      } else if (collision.teacher_id === parseInt(final_teacher_id, 10)) {
        reason = 'Teacher';
      }
      
      return res.status(400).json({ 
        message: `Conflict Detected! ${reason} is already occupied by the Year ${collision.year} ${collision.stream} class (${collision.subject_name}) during this time slot.` 
      });
    }

    // 2. Check for collisions in Active or Scheduled Sessions
    const { rows: sessionCollisions } = await pool.query(`
      SELECT s.*, sub.name as subject_name, sc.classroom_id as col_classroom_id FROM sessions s
      JOIN subjects sub ON s.subject_id = sub.id
      LEFT JOIN session_classrooms sc ON s.id = sc.session_id
      WHERE (sc.classroom_id = ANY($1) OR s.classroom_id = ANY($1) OR s.teacher_id = $2 OR (s.year = $3 AND s.stream = $4))
      AND s.status IN ('active', 'scheduled')
      AND TRIM(TO_CHAR(s.start_time AT TIME ZONE 'Asia/Kolkata', 'Day')) = $5
      AND s.start_time::time < $7::time AND s.end_time::time > $6::time
    `, [classroomIds, final_teacher_id, parseInt(year || '1', 10), stream || 'CSE', day_of_week, start_time, end_time]);

    if (sessionCollisions.length > 0) {
      const collision = sessionCollisions[0];
      let reason = 'Student Group';
      if (collision.col_classroom_id && classroomIds.includes(parseInt(collision.col_classroom_id, 10))) {
        const { rows: cls } = await pool.query('SELECT name FROM classrooms WHERE id = $1', [collision.col_classroom_id]);
        reason = `Classroom '${cls[0]?.name || collision.col_classroom_id}'`;
      } else if (collision.teacher_id === parseInt(final_teacher_id, 10)) {
        reason = `Teacher (${collision.teacher_id})`;
      }

      return res.status(400).json({ 
        message: `Conflict! ${reason} is currently in an active or scheduled session (${collision.subject_name}). Please end or cancel that session before assigning a new routine.` 
      });
    }

    const org_id = req.user.organization_id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const primaryClassroomId = classroomIds[0];

      const result = await client.query(
        'INSERT INTO schedules (subject_id, classroom_id, teacher_id, day_of_week, start_time, end_time, year, camera_id, stream, organization_id, valid_from) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
        [subject_id, primaryClassroomId, final_teacher_id, day_of_week, start_time, end_time, year || '1', camera_id || '0', stream || 'CSE', org_id, targetWeekStartStr]
      );
      const scheduleId = result.rows[0].id;

      for (const rId of classroomIds) {
        await client.query(
          'INSERT INTO schedule_classrooms (schedule_id, classroom_id) VALUES ($1, $2)',
          [scheduleId, rId]
        );
      }

      // --- Chatting (Node) Auto-Creation Logic ---
      const { rows: existingGroup } = await client.query(
        'SELECT id FROM chat_groups WHERE subject_id = $1 AND year = $2 AND stream = $3 AND organization_id = $4 LIMIT 1',
        [subject_id, year || '1', stream || 'CSE', org_id]
      );

      let groupId;
      if (existingGroup.length > 0) {
        groupId = existingGroup[0].id;
      } else {
        const { rows: subjectData } = await client.query('SELECT name FROM subjects WHERE id = $1', [subject_id]);
        const groupName = `${subjectData[0].name} - Yr${year || '1'} (${stream || 'CSE'})`;
        
        const newGroup = await client.query(
          'INSERT INTO chat_groups (name, subject_id, year, stream, organization_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [groupName, subject_id, year || '1', stream || 'CSE', org_id]
        );
        groupId = newGroup.rows[0].id;
      }

      // Ensure teacher is in the group members
      const { rowCount: isMember } = await client.query(
        'SELECT 1 FROM chat_group_members WHERE group_id = $1 AND teacher_id = $2',
        [groupId, final_teacher_id]
      );
      if (isMember === 0) {
        await client.query(
          'INSERT INTO chat_group_members (group_id, teacher_id) VALUES ($1, $2)',
          [groupId, final_teacher_id]
        );
      }
      // ------------------------------------------

      await client.query('COMMIT');
      res.status(201).json({ message: 'Schedule created successfully', id: scheduleId });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getSchedules = async (req, res) => {
  const { year, stream, week_start } = req.query;
  try {
    const targetWeekStart = getWeekStartDate(week_start);
    const targetWeekStartStr = toDateOnly(targetWeekStart);

    if (!isFutureWeek(targetWeekStart)) {
      await pool.query(`
        INSERT INTO timetable_week_entries (
          week_start, entry_date, source_type, source_id, action,
          subject_id, classroom_id, teacher_id, day_of_week, start_time, end_time,
          year, stream, camera_id, camera_name, created_by, organization_id
        )
        SELECT
          $1::date,
          $1::date + (
            CASE s.day_of_week
              WHEN 'Monday' THEN 0
              WHEN 'Tuesday' THEN 1
              WHEN 'Wednesday' THEN 2
              WHEN 'Thursday' THEN 3
              WHEN 'Friday' THEN 4
              WHEN 'Saturday' THEN 5
              ELSE 6
            END
          ),
          'regular',
          s.id,
          'active',
          s.subject_id,
          s.classroom_id,
          s.teacher_id,
          s.day_of_week,
          s.start_time,
          s.end_time,
          s.year,
          s.stream,
          s.camera_id,
          c.camera_name,
          $2,
          s.organization_id
        FROM schedules s
        LEFT JOIN classrooms c ON s.classroom_id = c.id
        WHERE s.valid_from <= $1::date + interval '6 days'
          AND (s.valid_until IS NULL OR $1::date < s.valid_until)
          AND ($3::int IS NULL OR s.organization_id = $3::int)
          AND NOT EXISTS (
            SELECT 1 FROM timetable_week_entries twe
            WHERE twe.week_start = $1::date
              AND twe.source_type = 'regular'
              AND twe.source_id = s.id
              AND twe.classroom_id = s.classroom_id
              AND twe.action = 'active'
          )
      `, [targetWeekStartStr, req.user?.id || null, req.user?.organization_id || null]);
    }

    let query = `
      SELECT s.id, s.subject_id, s.classroom_id, s.teacher_id, s.day_of_week, s.start_time, s.end_time, s.year, s.stream, s.organization_id, s.valid_from, s.valid_until,
             sub.name as subject_name, u.name as teacher_name, u.is_active as teacher_is_active,
             CASE WHEN cc.id IS NOT NULL THEN true ELSE false END as is_cancelled,
             false as is_deleted_history,
             false as is_snapshot_history,
             'regular' as source_type,
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', cl.id,
                   'name', cl.name
                 )
               ) FILTER (WHERE cl.id IS NOT NULL),
               '[]'::json
             ) as classrooms,
             STRING_AGG(cl.name, ', ') as classroom_name,
             MAX(cl.camera_name) as camera_name,
             MAX(s.camera_id) as camera_id
      FROM schedules s
      JOIN subjects sub ON s.subject_id = sub.id
      LEFT JOIN users u ON s.teacher_id = u.id
      LEFT JOIN schedule_classrooms sc ON s.id = sc.schedule_id
      LEFT JOIN classrooms cl ON sc.classroom_id = cl.id
      LEFT JOIN cancelled_classes cc ON s.id = cc.schedule_id
        AND cc.cancel_date >= $1::date
        AND cc.cancel_date < ($1::date + interval '7 days')
        AND TRIM(TO_CHAR(cc.cancel_date, 'Day')) = s.day_of_week
    `;
    const params = [targetWeekStartStr];
    const conditions = [];
    
    if (year) {
      params.push(String(year));
      conditions.push(`s.year::text = $${params.length}`);
    }
    
    if (stream) {
      params.push(String(stream));
      conditions.push(`s.stream ILIKE $${params.length}`);
    }

    const orgId = req.user?.organization_id;
    if (orgId) {
      params.push(orgId);
      conditions.push(`s.organization_id = $${params.length}`);
    }

    conditions.push(`s.valid_from <= $1::date + interval '6 days'`);
    conditions.push(`(s.valid_until IS NULL OR $1::date < s.valid_until)`);

    // Exclude schedules that have been marked as 'deleted' for this specific week's snapshot
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM timetable_week_entries twe 
      WHERE twe.week_start = $1::date 
        AND twe.source_type = 'regular' 
        AND twe.source_id = s.id 
        AND twe.action = 'deleted'
    )`);

    if (conditions.length > 0) {
      query += ` WHERE ` + conditions.join(' AND ');
    }

    query += ` GROUP BY s.id, sub.name, u.name, u.is_active, cc.id`;

    const { rows: schedules } = await pool.query(query, params);

    let historyQuery = `
      SELECT twe.id, twe.source_id, twe.subject_id, twe.classroom_id, twe.teacher_id,
             twe.day_of_week, twe.start_time, twe.end_time, twe.year, twe.stream, twe.camera_id, twe.camera_name,
             sub.name as subject_name, u.name as teacher_name, u.is_active as teacher_is_active, c.name as classroom_name,
             CASE WHEN twe.action = 'active' THEN false ELSE true END as is_cancelled,
             CASE WHEN twe.action = 'deleted' THEN true ELSE false END as is_deleted_history,
             true as is_snapshot_history,
             twe.source_type,
             twe.action as history_action
      FROM timetable_week_entries twe
      LEFT JOIN subjects sub ON twe.subject_id = sub.id
      LEFT JOIN users u ON twe.teacher_id = u.id
      LEFT JOIN classrooms c ON twe.classroom_id = c.id
      WHERE twe.week_start = $1::date
        AND (
          twe.action IN ('deleted', 'cancelled')
          OR twe.source_type = 'custom'
        )
    `;
    const historyParams = [targetWeekStartStr];
    if (year) {
      historyParams.push(String(year));
      historyQuery += ` AND twe.year::text = $${historyParams.length}`;
    }
    if (stream) {
      historyParams.push(String(stream));
      historyQuery += ` AND twe.stream ILIKE $${historyParams.length}`;
    }
    if (orgId) {
      historyParams.push(orgId);
      historyQuery += ` AND twe.organization_id = $${historyParams.length}`;
    }

    const { rows: historyRows } = await pool.query(historyQuery, historyParams);
    res.json([...schedules, ...historyRows]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getMySchedules = async (req, res) => {
  const teacher_id = req.user.id;
  try {
    const { rows: schedules } = await pool.query(`
      SELECT s.id, s.subject_id, s.classroom_id, s.teacher_id, s.day_of_week, s.start_time, s.end_time, s.year, s.stream, s.organization_id, s.valid_from, s.valid_until,
             sub.name as subject_name,
             CASE WHEN cc.id IS NOT NULL THEN true ELSE false END as is_cancelled,
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', cl.id,
                   'name', cl.name
                 )
               ) FILTER (WHERE cl.id IS NOT NULL),
               '[]'::json
             ) as classrooms,
             STRING_AGG(cl.name, ', ') as classroom_name
      FROM schedules s
      JOIN subjects sub ON s.subject_id = sub.id
      LEFT JOIN schedule_classrooms sc ON s.id = sc.schedule_id
      LEFT JOIN classrooms cl ON sc.classroom_id = cl.id
      LEFT JOIN cancelled_classes cc ON s.id = cc.schedule_id AND cc.cancel_date = CURRENT_DATE
      WHERE s.teacher_id = $1
        AND s.valid_from <= CURRENT_DATE
        AND (s.valid_until IS NULL OR CURRENT_DATE < s.valid_until)
      GROUP BY s.id, sub.name, cc.id
    `, [teacher_id]);
    res.json(schedules);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const updateSchedule = async (req, res) => {
  let { id } = req.params;
  if (String(id).startsWith('routine_')) id = id.replace('routine_', '');
  const { subject_id, teacher_id, camera_id, week_start } = req.body;

  let classroomIds = req.body.classroom_ids;
  if (!classroomIds && req.body.classroom_id) {
    classroomIds = [parseInt(req.body.classroom_id, 10)];
  }

  if (!classroomIds || !Array.isArray(classroomIds) || classroomIds.length === 0) {
    return res.status(400).json({ message: 'At least one classroom is required' });
  }

  try {
    const targetWeekStart = getWeekStartDate(week_start || req.query.week_start);
    const targetWeekStartStr = toDateOnly(targetWeekStart);

    console.log('[updateSchedule] Checking collisions for ID:', id, { classroomIds, teacher_id });
    // 1. Get original schedule info to get day and time
    const { rows: original } = await pool.query('SELECT * FROM schedules WHERE id = $1', [id]);
    if (original.length === 0) return res.status(404).json({ message: 'Schedule not found' });
    
    const { day_of_week, start_time, end_time } = original[0];

    // 2. Check for collisions in Regular Schedules (excluding current)
    const { rows: routineCollisions } = await pool.query(`
      SELECT s.*, sub.name as subject_name, sc.classroom_id as col_classroom_id FROM schedules s
      JOIN subjects sub ON s.subject_id = sub.id
      LEFT JOIN schedule_classrooms sc ON s.id = sc.schedule_id
      WHERE s.day_of_week = $1 AND s.start_time::time < $8::time AND s.end_time::time > $2::time
      AND (sc.classroom_id = ANY($3) OR s.classroom_id = ANY($3) OR s.teacher_id = $4 OR (s.year = $5 AND s.stream = $6))
      AND s.id != $7
      AND (s.valid_until IS NULL OR (s.valid_until > $9::date AND NOT EXISTS (
        SELECT 1 FROM timetable_week_entries twe 
        WHERE twe.week_start = $9::date 
          AND twe.source_type = 'regular' 
          AND twe.source_id = s.id 
          AND twe.action = 'deleted'
      )))
    `, [day_of_week, start_time, classroomIds, teacher_id, original[0].year, original[0].stream, id, end_time, targetWeekStartStr]);

    if (routineCollisions.length > 0) {
      const collision = routineCollisions[0];
      let reason = 'Student Group (Year/Stream)';
      if (collision.col_classroom_id && classroomIds.includes(parseInt(collision.col_classroom_id, 10))) {
        const { rows: cls } = await pool.query('SELECT name FROM classrooms WHERE id = $1', [collision.col_classroom_id]);
        reason = `Classroom '${cls[0]?.name || collision.col_classroom_id}'`;
      } else if (collision.teacher_id === parseInt(teacher_id, 10)) {
        reason = 'Teacher';
      }

      return res.status(400).json({ 
        message: `Conflict Detected! ${reason} is already occupied by the Year ${collision.year} ${collision.stream} class (${collision.subject_name}) during this time slot.` 
      });
    }

    // 3. Check for collisions in Active or Scheduled Sessions
    const { rows: sessionCollisions } = await pool.query(`
      SELECT s.*, sub.name as subject_name, sc.classroom_id as col_classroom_id FROM sessions s
      JOIN subjects sub ON s.subject_id = sub.id
      LEFT JOIN session_classrooms sc ON s.id = sc.session_id
      WHERE (sc.classroom_id = ANY($1) OR s.classroom_id = ANY($1) OR s.teacher_id = $2 OR (s.year = $3 AND s.stream = $4))
      AND s.status IN ('active', 'scheduled')
      AND TRIM(TO_CHAR(s.start_time AT TIME ZONE 'Asia/Kolkata', 'Day')) = $5
      AND s.start_time::time < $7::time AND s.end_time::time > $6::time
    `, [classroomIds, teacher_id, parseInt(original[0].year, 10), original[0].stream, day_of_week, start_time, end_time]);

    if (sessionCollisions.length > 0) {
      const collision = sessionCollisions[0];
      let reason = 'Student Group';
      if (collision.col_classroom_id && classroomIds.includes(parseInt(collision.col_classroom_id, 10))) {
        const { rows: cls } = await pool.query('SELECT name FROM classrooms WHERE id = $1', [collision.col_classroom_id]);
        reason = `Classroom '${cls[0]?.name || collision.col_classroom_id}'`;
      } else if (collision.teacher_id === parseInt(teacher_id, 10)) {
        reason = `Teacher (${collision.teacher_id})`;
      }

      return res.status(400).json({ 
        message: `Conflict! ${reason} is currently in an active or scheduled session (${collision.subject_name}). Please end or cancel that session before assigning a new routine.` 
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const primaryClassroomId = classroomIds[0];

      // 1. Soft delete the old schedule starting from this week
      await client.query(
        'UPDATE schedules SET valid_until = $1 WHERE id = $2',
        [targetWeekStartStr, id]
      );

      // 2. Insert the new schedule starting from this week
      const insertRes = await client.query(
        'INSERT INTO schedules (subject_id, classroom_id, teacher_id, day_of_week, start_time, end_time, year, camera_id, stream, organization_id, valid_from) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
        [subject_id, primaryClassroomId, teacher_id, day_of_week, start_time, end_time, original[0].year, camera_id || '0', original[0].stream, original[0].organization_id, targetWeekStartStr]
      );
      const newScheduleId = insertRes.rows[0].id;

      for (const rId of classroomIds) {
        await client.query(
          'INSERT INTO schedule_classrooms (schedule_id, classroom_id) VALUES ($1, $2)',
          [newScheduleId, rId]
        );
      }

      // --- Chatting (Node) Auto-Creation Logic ---
      const { rows: existingGroup } = await client.query(
        'SELECT id FROM chat_groups WHERE subject_id = $1 AND year = $2 AND stream = $3 AND organization_id = $4 LIMIT 1',
        [subject_id, original[0].year, original[0].stream, original[0].organization_id]
      );

      let groupId;
      if (existingGroup.length > 0) {
        groupId = existingGroup[0].id;
      } else {
        const { rows: subjectData } = await client.query('SELECT name FROM subjects WHERE id = $1', [subject_id]);
        const groupName = `${subjectData[0].name} - Yr${original[0].year} (${original[0].stream})`;
        
        const newGroup = await client.query(
          'INSERT INTO chat_groups (name, subject_id, year, stream, organization_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [groupName, subject_id, original[0].year, original[0].stream, original[0].organization_id]
        );
        groupId = newGroup.rows[0].id;
      }

      // Ensure teacher is in the group members
      const { rowCount: isMember } = await client.query(
        'SELECT 1 FROM chat_group_members WHERE group_id = $1 AND teacher_id = $2',
        [groupId, teacher_id]
      );
      if (isMember === 0) {
        await client.query(
          'INSERT INTO chat_group_members (group_id, teacher_id) VALUES ($1, $2)',
          [groupId, teacher_id]
        );
      }
      // ------------------------------------------

      await client.query('COMMIT');
      res.json({ message: 'Schedule updated' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const deleteSchedule = async (req, res) => {
  let { id } = req.params;
  if (String(id).startsWith('routine_')) id = id.replace('routine_', '');
  const weekStartInput = req.query.week_start || req.body?.week_start;
  try {
    const { rows } = await pool.query('SELECT * FROM schedules WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Schedule not found' });

    const schedule = rows[0];
    const targetWeekStart = getWeekStartDate(weekStartInput);
    const targetWeekStartStr = toDateOnly(targetWeekStart);
    const userRole = req.user?.role?.toLowerCase();

    // ── Record in History Snapshot ──
    await pool.query(`
      INSERT INTO timetable_week_entries (
        week_start, entry_date, source_type, source_id, action,
        subject_id, classroom_id, teacher_id, day_of_week, start_time, end_time,
        year, stream, camera_id, camera_name, created_by, organization_id
      )
      VALUES ($1, $2, 'regular', $3, 'deleted', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `, [
      targetWeekStartStr,
      toDateOnly(getDateForDay(targetWeekStart, schedule.day_of_week)),
      schedule.id,
      schedule.subject_id,
      schedule.classroom_id,
      schedule.teacher_id,
      schedule.day_of_week,
      schedule.start_time,
      schedule.end_time,
      schedule.year,
      schedule.stream,
      schedule.camera_id,
      schedule.camera_name,
      req.user?.id || null,
      schedule.organization_id,
    ]);

    if (userRole === 'admin') {
      // If it's today, stop any active session for this schedule
      const { rows: cancelledSessions } = await pool.query(`
        UPDATE sessions 
        SET status = 'cancelled'
        WHERE (schedule_id = $1 OR (subject_id = $2 AND classroom_id = $3 AND teacher_id = $4))
        AND (start_time AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND is_custom = false
        RETURNING id
      `, [id, schedule.subject_id, schedule.classroom_id, schedule.teacher_id]);

      // Soft-delete the schedule from the routine starting next week
      await pool.query(`
        UPDATE schedules
        SET valid_until = $1::date + interval '7 days'
        WHERE id = $2
      `, [targetWeekStartStr, id]);

      const io = req.app.get('io');
      if (io && cancelledSessions.length > 0) {
        cancelledSessions.forEach(s => {
          if (schedule.organization_id) {
            io.to(`org_${schedule.organization_id}`).emit('session_ended', { id: s.id, organization_id: schedule.organization_id });
          } else {
            io.emit('session_ended', { id: s.id });
          }
        });
      }

      res.json({ message: 'Routine updated: Class permanently removed and active session stopped.', role: 'admin' });
    } else {
      res.json({ message: 'Class removed from this week only.', role: 'teacher' });
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const cancelSchedule = async (req, res) => {
  let { id } = req.params;
  if (String(id).startsWith('routine_')) id = id.replace('routine_', '');
  const { password, cancel_date, week_start } = req.body;
  const teacher_id = req.user.id;

  try {
    const { rows: schedules } = await pool.query('SELECT * FROM schedules WHERE id = $1 AND teacher_id = $2', [id, teacher_id]);
    if (schedules.length === 0) {
      return res.status(404).json({ message: 'Schedule not found or unauthorized' });
    }

    const { rows: users } = await pool.query('SELECT password FROM users WHERE id = $1', [teacher_id]);
    if (users.length === 0) return res.status(404).json({ message: 'Teacher not found' });
    
    const isMatch = await bcrypt.compare(password, users[0].password);
    if (!isMatch) {
      return res.status(403).json({ message: 'Invalid password. Cancellation denied.' });
    }

    const finalCancelDate = cancel_date || toDateOnly(new Date());
    const finalWeekStart = week_start || toDateOnly(getWeekStartDate());

    await pool.query('INSERT INTO cancelled_classes (schedule_id, cancel_date) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, finalCancelDate]);

    // Snapshot entry for the specific week
    const schedule = schedules[0];
    await pool.query(`
      INSERT INTO timetable_week_entries (
        week_start, entry_date, source_type, source_id, action,
        subject_id, classroom_id, teacher_id, day_of_week, start_time, end_time,
        year, stream, camera_id, camera_name, created_by, organization_id
      )
      SELECT $1, $2, 'regular', $3, 'cancelled', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
      WHERE NOT EXISTS (
        SELECT 1 FROM timetable_week_entries
        WHERE week_start = $1::date
          AND entry_date = $2::date
          AND source_type = 'regular'
          AND source_id = $3
          AND action = 'cancelled'
      )
    `, [
      finalWeekStart,
      finalCancelDate,
      schedule.id,
      schedule.subject_id,
      schedule.classroom_id,
      schedule.teacher_id,
      schedule.day_of_week,
      schedule.start_time,
      schedule.end_time,
      schedule.year,
      schedule.stream,
      schedule.camera_id,
      schedule.camera_name,
      teacher_id,
      schedule.organization_id,
    ]);

    // If it's today, stop the active session by marking it cancelled
    if (finalCancelDate === toDateOnly(new Date())) {
      const { rows: activeSessions } = await pool.query(`
        UPDATE sessions 
        SET status = 'cancelled'
        WHERE (schedule_id = $1 OR (subject_id = $2 AND classroom_id = $3 AND teacher_id = $4))
        AND (start_time AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND is_custom = false
        RETURNING *
      `, [id, schedule.subject_id, schedule.classroom_id, schedule.teacher_id]);

      if (activeSessions.length > 0) {
        for (const sess of activeSessions) {
          if (sess.year && sess.stream) {
            const { rows: roster } = await pool.query(
              "SELECT id FROM students WHERE year::text = $1::text AND LOWER(stream) = LOWER($2) AND status = 'active'",
              [sess.year, sess.stream]
            );
            if (roster.length > 0) {
              const valueStrings = roster.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(',');
              const flatValues = roster.flatMap(s => [s.id, sess.id, 'absent']);
              await pool.query(`
                INSERT INTO attendance (student_id, session_id, status)
                VALUES ${valueStrings}
                ON CONFLICT (student_id, session_id) DO NOTHING
              `, flatValues);
            }
          }
        }
      }

      const io = req.app.get('io');
      if (io && activeSessions.length > 0) {
        activeSessions.forEach(s => {
          if (schedule.organization_id) {
            io.to(`org_${schedule.organization_id}`).emit('session_ended', { id: s.id, organization_id: schedule.organization_id });
          } else {
            io.emit('session_ended', { id: s.id });
          }
        });
      }
    }

    if (schedule.subject_id && schedule.classroom_id) {
      const { rows: meta } = await pool.query(
        `SELECT sub.name as subject_name, c.name as classroom_name 
         FROM subjects sub, classrooms c 
         WHERE sub.id = $1 AND c.id = $2`,
        [schedule.subject_id, schedule.classroom_id]
      );

      if (meta[0] && schedule.year && schedule.stream) {
        const orgId = schedule.organization_id;
        const notifTitle = 'Routine Class Cancelled';
        const notifMsg = `The ${meta[0].subject_name} class scheduled for ${schedule.day_of_week} (${finalCancelDate}) in ${meta[0].classroom_name} has been cancelled by ${req.user?.name || 'Faculty'}.`;
        const notifMeta = { year: schedule.year, stream: schedule.stream, schedule_id: id, subject_name: meta[0].subject_name, week_start: finalWeekStart };
        const notifUrl = `/routine?week_start=${finalWeekStart}`;

        sendCohortNotification({
          organization_id: orgId,
          year: schedule.year,
          stream: schedule.stream,
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

    res.json({ message: 'Class cancelled successfully for ' + finalCancelDate });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
