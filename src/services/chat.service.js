import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import pool from "../config/database.config.js";
import Message from "../models/message.model.js";

dotenv.config();

export const initChatSockets = (io) => {
  const chatNamespace = io.of("/chat");

  // Socket Authentication Middleware
  chatNamespace.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization;
    if (!token) {
      return next(new Error("Authentication error: Token missing"));
    }

    const actualToken = token.startsWith("Bearer ") ? token.split(" ")[1] : token;

    jwt.verify(actualToken, process.env.JWT_SECRET || "secret", (err, user) => {
      if (err) return next(new Error("Authentication error: Invalid token"));
      socket.user = user;
      next();
    });
  });

  chatNamespace.on("connection", (socket) => {
    console.log(`[Chat Socket] User connected: ${socket.user.id} (${socket.user.role})`);

    // Join a specific group room
    socket.on("join_group", async (groupId, callback) => {
      try {
        // Optional: Verify in PostgreSQL if user is actually a member of this group
        let isMember = false;
        
        if (socket.user.role === 'admin') {
          isMember = true; // Admins can join any group
        } else {
          const userCol = socket.user.role === 'student' ? 'student_id' : 'teacher_id';
          const { rowCount } = await pool.query(
            `SELECT 1 FROM chat_group_members WHERE group_id = $1 AND ${userCol} = $2`,
            [groupId, socket.user.id]
          );
          isMember = rowCount > 0;
        }

        if (!isMember) {
          if (callback) callback({ error: "Access denied: Not a member of this group" });
          return;
        }

        const roomName = `group_${groupId}`;
        socket.join(roomName);
        console.log(`[Chat Socket] User ${socket.user.id} joined room ${roomName}`);
        
        if (callback) callback({ success: true, room: roomName });
      } catch (error) {
        console.error("[Chat Socket] Join group error:", error);
        if (callback) callback({ error: "Server error joining group" });
      }
    });

    // Leave a specific group room
    socket.on("leave_group", (groupId) => {
      const roomName = `group_${groupId}`;
      socket.leave(roomName);
    });

    // Handle incoming messages
    socket.on("send_message", async (data, callback) => {
      try {
        const { groupId, content, attachmentUrl } = data;

        if (!groupId || !content) {
          if (callback) callback({ error: "Missing groupId or content" });
          return;
        }

        // Save to MongoDB
        const newMessage = new Message({
          groupId,
          senderId: socket.user.id,
          senderType: socket.user.role,
          content,
          attachmentUrl
        });

        const savedMessage = await newMessage.save();

        // Broadcast to the room
        chatNamespace.to(`group_${groupId}`).emit("receive_message", savedMessage);

        if (callback) callback({ success: true, message: savedMessage });
      } catch (error) {
        console.error("[Chat Socket] Send message error:", error);
        if (callback) callback({ error: "Failed to send message" });
      }
    });

    socket.on("disconnect", () => {
      console.log(`[Chat Socket] User disconnected: ${socket.user.id}`);
    });
  });
};
