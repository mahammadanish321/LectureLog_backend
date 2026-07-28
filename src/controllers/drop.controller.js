import pool from '../config/database.config.js';

export const createDrop = async (req, res) => {
  try {
    const { title, body } = req.body;
    const { id, role, organization_id } = req.user;

    const authorField = role === 'student' ? 'author_student_id' : 'author_teacher_id';

    const result = await pool.query(
      `INSERT INTO drops (title, body, ${authorField}, organization_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [title, body, id, organization_id]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating drop:', error);
    res.status(500).json({ message: 'Server error creating drop.' });
  }
};

export const getAllDrops = async (req, res) => {
  try {
    const { sort = 'hot', page = 1, limit = 20 } = req.query;
    const { id, role, organization_id } = req.user;
    
    const offset = (page - 1) * limit;
    const voterField = role === 'student' ? 'voter_student_id' : 'voter_teacher_id';

    let orderClause = 'ORDER BY d.created_at DESC'; // default to new
    if (sort === 'hot') {
      orderClause = 'ORDER BY (d.score + 1) / POWER(EXTRACT(EPOCH FROM (NOW() - d.created_at)) / 3600 + 2, 1.5) DESC';
    } else if (sort === 'top') {
      orderClause = 'ORDER BY d.score DESC, d.created_at DESC';
    }

    const query = `
      SELECT 
        d.*,
        COALESCE(u.name, s.name) as author_name,
        COALESCE(u.role, 'student') as author_role,
        COALESCE(u.image_url, s.image_url) as author_image,
        COALESCE(dv.vote, 0) as user_vote
      FROM drops d
      LEFT JOIN users u ON d.author_teacher_id = u.id
      LEFT JOIN students s ON d.author_student_id = s.id
      LEFT JOIN drop_votes dv ON d.id = dv.drop_id AND dv.${voterField} = $1
      WHERE d.organization_id = $2 AND d.is_deleted = false
      ${orderClause}
      LIMIT $3 OFFSET $4
    `;

    const countQuery = `
      SELECT COUNT(*) 
      FROM drops 
      WHERE organization_id = $1 AND is_deleted = false
    `;

    const [dropsResult, countResult] = await Promise.all([
      pool.query(query, [id, organization_id, limit, offset]),
      pool.query(countQuery, [organization_id])
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      drops: dropsResult.rows,
      total,
      page: parseInt(page),
      totalPages
    });
  } catch (error) {
    console.error('Error fetching drops:', error);
    res.status(500).json({ message: 'Server error fetching drops.' });
  }
};

export const getDropById = async (req, res) => {
  try {
    const dropId = req.params.id;
    const { id, role } = req.user;
    const voterField = role === 'student' ? 'voter_student_id' : 'voter_teacher_id';

    const dropQuery = `
      SELECT 
        d.*,
        COALESCE(u.name, s.name) as author_name,
        COALESCE(u.role, 'student') as author_role,
        COALESCE(u.image_url, s.image_url) as author_image,
        COALESCE(dv.vote, 0) as user_vote
      FROM drops d
      LEFT JOIN users u ON d.author_teacher_id = u.id
      LEFT JOIN students s ON d.author_student_id = s.id
      LEFT JOIN drop_votes dv ON d.id = dv.drop_id AND dv.${voterField} = $1
      WHERE d.id = $2 AND d.is_deleted = false
    `;

    const dropResult = await pool.query(dropQuery, [id, dropId]);

    if (dropResult.rows.length === 0) {
      return res.status(404).json({ message: 'Drop not found.' });
    }

    const commentsQuery = `
      SELECT 
        c.*,
        COALESCE(u.name, s.name) as author_name,
        COALESCE(u.role, 'student') as author_role,
        COALESCE(u.image_url, s.image_url) as author_image,
        COALESCE(cv.vote, 0) as user_vote
      FROM drop_comments c
      LEFT JOIN users u ON c.author_teacher_id = u.id
      LEFT JOIN students s ON c.author_student_id = s.id
      LEFT JOIN drop_comment_votes cv ON c.id = cv.comment_id AND cv.${voterField} = $1
      WHERE c.drop_id = $2 AND c.is_deleted = false
      ORDER BY c.created_at ASC
    `;

    const commentsResult = await pool.query(commentsQuery, [id, dropId]);

    const drop = dropResult.rows[0];
    drop.comments = commentsResult.rows;

    res.status(200).json({ drop });
  } catch (error) {
    console.error('Error fetching drop:', error);
    res.status(500).json({ message: 'Server error fetching drop.' });
  }
};

export const voteDrop = async (req, res) => {
  const client = await pool.connect();
  try {
    const dropId = req.params.id;
    const { vote } = req.body;
    const { id, role } = req.user;
    
    if (![1, -1, 0].includes(vote)) {
      return res.status(400).json({ message: 'Invalid vote value.' });
    }

    const voterField = role === 'student' ? 'voter_student_id' : 'voter_teacher_id';

    await client.query('BEGIN');

    if (vote === 0) {
      await client.query(
        `DELETE FROM drop_votes WHERE drop_id = $1 AND ${voterField} = $2`,
        [dropId, id]
      );
    } else {
      await client.query(
        `INSERT INTO drop_votes (drop_id, ${voterField}, vote)
         VALUES ($1, $2, $3)
         ON CONFLICT (drop_id, ${voterField}) 
         DO UPDATE SET vote = EXCLUDED.vote`,
        [dropId, id, vote]
      );
    }

    const scoreResult = await client.query(
      `UPDATE drops 
       SET score = (SELECT COALESCE(SUM(vote), 0) FROM drop_votes WHERE drop_id = $1)
       WHERE id = $1
       RETURNING score`,
      [dropId]
    );

    await client.query('COMMIT');
    
    res.status(200).json({ 
      score: scoreResult.rows[0].score, 
      user_vote: vote 
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error voting on drop:', error);
    res.status(500).json({ message: 'Server error voting on drop.' });
  } finally {
    client.release();
  }
};

export const deleteDrop = async (req, res) => {
  try {
    const dropId = req.params.id;
    const { id, role } = req.user;
    
    const dropResult = await pool.query('SELECT * FROM drops WHERE id = $1', [dropId]);
    if (dropResult.rows.length === 0) {
      return res.status(404).json({ message: 'Drop not found.' });
    }
    const drop = dropResult.rows[0];

    const isAuthor = (role === 'student' && drop.author_student_id === id) || 
                     (role !== 'student' && drop.author_teacher_id === id);
    const isAdmin = role === 'admin';

    if (!isAuthor && !isAdmin) {
      return res.status(403).json({ message: 'Not authorized to delete this drop.' });
    }

    await pool.query('UPDATE drops SET is_deleted = true WHERE id = $1', [dropId]);
    res.status(200).json({ message: 'Drop deleted successfully.' });
  } catch (error) {
    console.error('Error deleting drop:', error);
    res.status(500).json({ message: 'Server error deleting drop.' });
  }
};

export const createComment = async (req, res) => {
  const client = await pool.connect();
  try {
    const dropId = req.params.id;
    const { body } = req.body;
    const { id, role } = req.user;

    const authorField = role === 'student' ? 'author_student_id' : 'author_teacher_id';

    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO drop_comments (drop_id, body, ${authorField})
       VALUES ($1, $2, $3)
       RETURNING *`,
      [dropId, body, id]
    );

    await client.query(
      `UPDATE drops SET comment_count = comment_count + 1 WHERE id = $1`,
      [dropId]
    );

    await client.query('COMMIT');
    
    const comment = result.rows[0];
    
    // Fetch author info to match returned format
    const authorQuery = role === 'student' 
      ? 'SELECT name as author_name, image_url as author_image FROM students WHERE id = $1'
      : 'SELECT name as author_name, image_url as author_image, role as author_role FROM users WHERE id = $1';
    
    const authorResult = await pool.query(authorQuery, [id]);
    const authorData = authorResult.rows[0];
    
    res.status(201).json({
      ...comment,
      author_name: authorData.author_name,
      author_role: role === 'student' ? 'student' : authorData.author_role,
      author_image: authorData.author_image,
      user_vote: 0
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating comment:', error);
    res.status(500).json({ message: 'Server error creating comment.' });
  } finally {
    client.release();
  }
};

export const voteComment = async (req, res) => {
  const client = await pool.connect();
  try {
    const commentId = req.params.commentId;
    const { vote } = req.body;
    const { id, role } = req.user;
    
    if (![1, -1, 0].includes(vote)) {
      return res.status(400).json({ message: 'Invalid vote value.' });
    }

    const voterField = role === 'student' ? 'voter_student_id' : 'voter_teacher_id';

    await client.query('BEGIN');

    if (vote === 0) {
      await client.query(
        `DELETE FROM drop_comment_votes WHERE comment_id = $1 AND ${voterField} = $2`,
        [commentId, id]
      );
    } else {
      await client.query(
        `INSERT INTO drop_comment_votes (comment_id, ${voterField}, vote)
         VALUES ($1, $2, $3)
         ON CONFLICT (comment_id, ${voterField}) 
         DO UPDATE SET vote = EXCLUDED.vote`,
        [commentId, id, vote]
      );
    }

    const scoreResult = await client.query(
      `UPDATE drop_comments 
       SET score = (SELECT COALESCE(SUM(vote), 0) FROM drop_comment_votes WHERE comment_id = $1)
       WHERE id = $1
       RETURNING score`,
      [commentId]
    );

    await client.query('COMMIT');
    
    res.status(200).json({ 
      score: scoreResult.rows[0].score, 
      user_vote: vote 
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error voting on comment:', error);
    res.status(500).json({ message: 'Server error voting on comment.' });
  } finally {
    client.release();
  }
};

export const deleteComment = async (req, res) => {
  const client = await pool.connect();
  try {
    const commentId = req.params.commentId;
    const { id, role } = req.user;
    
    const commentResult = await client.query('SELECT * FROM drop_comments WHERE id = $1', [commentId]);
    if (commentResult.rows.length === 0) {
      return res.status(404).json({ message: 'Comment not found.' });
    }
    const comment = commentResult.rows[0];

    const isAuthor = (role === 'student' && comment.author_student_id === id) || 
                     (role !== 'student' && comment.author_teacher_id === id);
    const isAdmin = role === 'admin';

    if (!isAuthor && !isAdmin) {
      return res.status(403).json({ message: 'Not authorized to delete this comment.' });
    }

    await client.query('BEGIN');
    await client.query('UPDATE drop_comments SET is_deleted = true WHERE id = $1', [commentId]);
    await client.query('UPDATE drops SET comment_count = comment_count - 1 WHERE id = $1', [comment.drop_id]);
    await client.query('COMMIT');
    
    res.status(200).json({ message: 'Comment deleted successfully.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting comment:', error);
    res.status(500).json({ message: 'Server error deleting comment.' });
  } finally {
    client.release();
  }
};
