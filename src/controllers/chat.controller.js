import pool from "../config/database.config.js";
import Message from "../models/message.model.js";
import { enrichMessagesWithUserDetails } from "../utils/userLookup.js";
import cloudinary from "../config/cloudinary.config.js";

// Get all chat groups the current user is a member of
export const getMyGroups = async (req, res) => {
  try {
    const userId = req.user.id;
    const role = req.user.role;
    const orgId = req.user.organization_id;

    let query = '';
    let params = [];

    if (role === 'admin') {
      // Admins see all groups in their organization
      query = `
        SELECT cg.id, cg.name, cg.subject_id, cg.year, cg.stream, cg.created_at
        FROM chat_groups cg
        WHERE cg.organization_id = $1
        ORDER BY cg.created_at DESC
      `;
      params = [orgId];
    } else if (role === 'student') {
      // Students see groups matching their year, stream, and org
      query = `
        SELECT cg.id, cg.name, cg.subject_id, cg.year, cg.stream, cg.created_at
        FROM chat_groups cg
        JOIN students s ON cg.year = s.year AND cg.stream = s.stream AND cg.organization_id = s.organization_id
        WHERE s.id = $1 AND cg.organization_id = $2
        ORDER BY cg.created_at DESC
      `;
      params = [userId, orgId];
    } else {
      // Teachers only see groups they are explicitly added to
      query = `
        SELECT cg.id, cg.name, cg.subject_id, cg.year, cg.stream, cg.created_at
        FROM chat_groups cg
        JOIN chat_group_members cgm ON cg.id = cgm.group_id
        WHERE cgm.teacher_id = $1 AND cg.organization_id = $2
        ORDER BY cg.created_at DESC
      `;
      params = [userId, orgId];
    }

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('[Chat Controller] getMyGroups error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Get paginated messages for a specific group (from MongoDB)
export const getGroupMessages = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Verify membership
    if (req.user.role !== 'admin') {
      if (req.user.role === 'student') {
        // Verify group matches student's year and stream
        const { rowCount } = await pool.query(
          `SELECT 1 FROM chat_groups cg 
           JOIN students s ON cg.year = s.year AND cg.stream = s.stream AND cg.organization_id = s.organization_id
           WHERE cg.id = $1 AND s.id = $2`,
          [groupId, req.user.id]
        );
        if (rowCount === 0) {
          return res.status(403).json({ message: 'Access denied: Group does not match your year and stream' });
        }
      } else {
        // Verify teacher is explicitly in group_members
        const { rowCount } = await pool.query(
          `SELECT 1 FROM chat_group_members WHERE group_id = $1 AND teacher_id = $2`,
          [groupId, req.user.id]
        );
        if (rowCount === 0) {
          return res.status(403).json({ message: 'Access denied to this group' });
        }
      }
    }

    const messages = await Message.find({ groupId })
      .sort({ createdAt: -1 }) // Newest first
      .skip(skip)
      .limit(parseInt(limit))
      .populate('replyTo', 'content senderId senderType attachmentUrls isDeleted');

    const enrichedMessages = await enrichMessagesWithUserDetails(messages.reverse());

    res.json(enrichedMessages); // Send back in chronological order for UI
  } catch (error) {
    console.error('[Chat Controller] getGroupMessages error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Get total members stats for a group
export const getGroupStats = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get the group details to find its year/stream/org
    const groupRes = await pool.query(
      'SELECT year, stream, organization_id FROM chat_groups WHERE id = $1',
      [id]
    );
    
    if (groupRes.rowCount === 0) {
      return res.status(404).json({ message: 'Group not found' });
    }
    
    const { year, stream, organization_id } = groupRes.rows[0];
    
    // Count students in that year/stream/org
    const studentsRes = await pool.query(
      'SELECT count(*) FROM students WHERE year = $1 AND stream = $2 AND organization_id = $3',
      [year, stream, organization_id]
    );
    
    // Count teachers directly assigned to the group
    const teachersRes = await pool.query(
      'SELECT count(*) FROM chat_group_members WHERE group_id = $1',
      [id]
    );
    
    const totalStudents = parseInt(studentsRes.rows[0].count);
    const totalTeachers = parseInt(teachersRes.rows[0].count);
    
    res.json({
      totalStudents,
      totalTeachers,
      totalMembers: totalStudents + totalTeachers
    });
    
  } catch (error) {
    console.error('[Chat Controller] getGroupStats error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Handle file attachment upload
export const uploadAttachment = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "No files uploaded" });
    }
    
    // req.files is uploaded via multer-storage-cloudinary
    // so req.files[i].path contains the Cloudinary secure URL
    const urls = req.files.map(file => file.path);
    res.json({ urls });
  } catch (error) {
    console.error('[Chat Controller] uploadAttachment error:', error);
    res.status(500).json({ message: 'Failed to upload attachments' });
  }
};
