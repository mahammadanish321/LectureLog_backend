import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import pool from "../config/database.config.js";
import Message from "../models/message.model.js";
import { getUserDetails } from "../utils/userLookup.js";

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
        // Verify in PostgreSQL if user is allowed in this group
        let isMember = false;
        
        if (socket.user.role === 'admin') {
          // Admins can join any group IN THEIR ORGANIZATION
          const { rowCount } = await pool.query(
            'SELECT 1 FROM chat_groups WHERE id = $1 AND organization_id = $2',
            [groupId, socket.user.organization_id]
          );
          isMember = rowCount > 0;
        } else if (socket.user.role === 'student') {
          // Verify group matches student's year and stream
          const { rowCount } = await pool.query(
            `SELECT 1 FROM chat_groups cg 
             JOIN students s ON cg.year = s.year AND cg.stream = s.stream AND cg.organization_id = s.organization_id
             WHERE cg.id = $1 AND s.id = $2`,
            [groupId, socket.user.id]
          );
          isMember = rowCount > 0;
        } else {
          // Verify teacher is explicitly in group_members
          const { rowCount } = await pool.query(
            `SELECT 1 FROM chat_group_members WHERE group_id = $1 AND teacher_id = $2`,
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
        
        // Broadcast presence
        const socketsInRoom = await chatNamespace.in(roomName).fetchSockets();
        const onlineClassmates = Array.from(new Set(socketsInRoom.map(s => s.user.id)));
        chatNamespace.to(roomName).emit('presence_update', { onlineClassmates, groupId });

        if (callback) callback({ success: true, room: roomName });
      } catch (error) {
        console.error("[Chat Socket] Join group error:", error);
        if (callback) callback({ error: "Server error joining group" });
      }
    });

    // Leave a specific group room
    socket.on("leave_group", async (groupId) => {
      const roomName = `group_${groupId}`;
      socket.leave(roomName);
      
      const socketsInRoom = await chatNamespace.in(roomName).fetchSockets();
      const onlineClassmates = Array.from(new Set(socketsInRoom.map(s => s.user.id)));
      chatNamespace.to(roomName).emit('presence_update', { onlineClassmates, groupId });
    });

    // Typing Indicators
    socket.on("typing", ({ groupId, name }) => {
      socket.to(`group_${groupId}`).emit("user_typing", { groupId, userId: socket.user.id, name });
    });

    socket.on("stop_typing", ({ groupId }) => {
      socket.to(`group_${groupId}`).emit("user_stop_typing", { groupId, userId: socket.user.id });
    });

    // Read Receipts
    socket.on("mark_seen", async ({ messageId, groupId }) => {
      try {
        const updatedMsg = await Message.findByIdAndUpdate(
          messageId,
          {
            $addToSet: {
              seenBy: { userId: socket.user.id, role: socket.user.role }
            }
          },
          { new: true }
        );
        if (updatedMsg) {
          chatNamespace.to(`group_${groupId}`).emit("message_seen", {
            messageId,
            groupId,
            seenBy: updatedMsg.seenBy
          });
        }
      } catch (err) {
        console.error("mark_seen error:", err);
      }
    });

    // Handle incoming messages
    socket.on("send_message", async (data, callback) => {
      try {
        const { groupId, content, attachmentUrls, replyTo } = data;

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
          attachmentUrls: attachmentUrls || [],
          replyTo: replyTo || null
        });

        await newMessage.save();
        
        // Fetch it back with populated replyTo
        const savedMessage = await Message.findById(newMessage._id).populate('replyTo', 'content senderId senderType attachmentUrls isDeleted');

        // Enrich with sender details before broadcasting
        const senderDetails = await getUserDetails(socket.user.id, socket.user.role);
        
        const messageToBroadcast = {
          ...savedMessage.toObject(),
          senderName: senderDetails.name,
          senderAvatar: senderDetails.image_url
        };
        
        // Enrich the replied-to user's name if applicable
        if (messageToBroadcast.replyTo && messageToBroadcast.replyTo.senderId) {
          const replyDetails = await getUserDetails(messageToBroadcast.replyTo.senderId, messageToBroadcast.replyTo.senderType);
          messageToBroadcast.replyTo.senderName = replyDetails.name;
        }

        // Broadcast to the room
        chatNamespace.to(`group_${groupId}`).emit("receive_message", messageToBroadcast);

        if (callback) callback({ success: true, message: messageToBroadcast });
      } catch (error) {
        console.error("[Chat Socket] Send message error:", error);
        if (callback) callback({ error: "Failed to send message" });
      }
    });

    socket.on("disconnecting", async () => {
      const roomsToUpdate = Array.from(socket.rooms).filter(r => r.startsWith("group_"));
      
      roomsToUpdate.forEach(async (room) => {
        const socketsInRoom = await chatNamespace.in(room).fetchSockets();
        const onlineClassmates = Array.from(new Set(
          socketsInRoom
            .filter(s => s.id !== socket.id)
            .map(s => s.user.id)
        ));
        chatNamespace.to(room).emit('presence_update', { onlineClassmates, groupId: room.split('_')[1] });
      });
    });

    socket.on("disconnect", () => {
      console.log(`[Chat Socket] User disconnected: ${socket.user.id}`);
    });
  });
};
