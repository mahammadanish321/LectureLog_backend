import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  groupId: {
    type: Number, // Reference to PostgreSQL chat_groups.id
    required: true,
    index: true,
  },
  senderId: {
    type: Number, // Reference to PostgreSQL users.id or students.id
    required: true,
  },
  senderType: {
    type: String,
    enum: ['teacher', 'admin', 'student'],
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  attachmentUrl: {
    type: String,
    default: null,
  },
  isDeleted: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true });

// Optimize querying messages by group ordered by creation time
messageSchema.index({ groupId: 1, createdAt: 1 });

const Message = mongoose.model('Message', messageSchema);
export default Message;
