import pool from "../config/database.config.js";
import Message from "../models/message.model.js";

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
    } else {
      const userCol = role === 'student' ? 'student_id' : 'teacher_id';
      query = `
        SELECT cg.id, cg.name, cg.subject_id, cg.year, cg.stream, cg.created_at
        FROM chat_groups cg
        JOIN chat_group_members cgm ON cg.id = cgm.group_id
        WHERE cgm.${userCol} = $1 AND cg.organization_id = $2
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

    // Verify membership (Optional but recommended for security)
    if (req.user.role !== 'admin') {
      const userCol = req.user.role === 'student' ? 'student_id' : 'teacher_id';
      const { rowCount } = await pool.query(
        `SELECT 1 FROM chat_group_members WHERE group_id = $1 AND ${userCol} = $2`,
        [groupId, req.user.id]
      );
      if (rowCount === 0) {
        return res.status(403).json({ message: 'Access denied to this group' });
      }
    }

    const messages = await Message.find({ groupId })
      .sort({ createdAt: -1 }) // Newest first
      .skip(skip)
      .limit(parseInt(limit));

    res.json(messages.reverse()); // Send back in chronological order for UI
  } catch (error) {
    console.error('[Chat Controller] getGroupMessages error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
