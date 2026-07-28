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
  attachmentUrls: {
    type: [String],
    default: [],
  },
  replyTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message',
    default: null,
  },
  seenBy: {
    type: [{
      userId: { type: Number, required: true },
      role: { type: String, required: true }
    }],
    default: []
  },
  isNoteFolder: {
    type: Boolean,
    default: false,
  },
  scheduleId: {
    type: Number,
    default: null,
  },
  sessionId: {
    type: Number,
    default: null,
  },
  noteFolderName: {
    type: String,
  },
  isEdited: {
    type: Boolean,
    default: false,
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
