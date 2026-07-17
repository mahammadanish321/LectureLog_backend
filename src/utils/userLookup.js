import pool from "../config/database.config.js";

/**
 * Fetches user details (name, image_url) from PostgreSQL based on role and ID.
 * @param {Number} id - User ID
 * @param {String} role - 'admin', 'teacher', or 'student'
 * @returns {Promise<Object>} { name, image_url }
 */
export const getUserDetails = async (id, role) => {
  try {
    let query = '';
    
    if (role === 'admin' || role === 'teacher') {
      query = 'SELECT name, image_url FROM users WHERE id = $1';
    } else if (role === 'student') {
      query = 'SELECT name, roll_number, image_url FROM students WHERE id = $1';
    } else {
      return { name: `Unknown ${role}`, image_url: null };
    }

    const { rows } = await pool.query(query, [id]);
    
    if (rows.length > 0) {
      let displayName = rows[0].name || `${role} ${id}`;
      if (role === 'student' && rows[0].roll_number) {
        displayName += ` (Roll: ${rows[0].roll_number})`;
      }
      return { 
        name: displayName, 
        image_url: rows[0].image_url || null 
      };
    }
    
    return { name: `${role} ${id}`, image_url: null };
  } catch (error) {
    console.error(`[UserLookup] Error fetching details for ${role} ${id}:`, error);
    return { name: `${role} ${id}`, image_url: null };
  }
};

/**
 * Enriches an array of messages with sender details.
 * @param {Array} messages - Array of Mongoose message objects
 * @returns {Promise<Array>} Messages with senderName and senderAvatar
 */
export const enrichMessagesWithUserDetails = async (messages) => {
  // Cache to avoid duplicate queries for the same user in a single request
  const userCache = {};
  
  const enrichedMessages = [];
  
  for (const msg of messages) {
    const msgObj = msg.toObject ? msg.toObject() : { ...msg };
    const cacheKey = `${msgObj.senderType}_${msgObj.senderId}`;
    
    if (!userCache[cacheKey]) {
      userCache[cacheKey] = await getUserDetails(msgObj.senderId, msgObj.senderType);
    }
    
    msgObj.senderName = userCache[cacheKey].name;
    msgObj.senderAvatar = userCache[cacheKey].image_url;
    
    enrichedMessages.push(msgObj);
  }
  
  return enrichedMessages;
};
