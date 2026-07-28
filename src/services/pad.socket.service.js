export let padNamespace;

export const initPadSockets = (io) => {
  padNamespace = io.of('/pads');

  padNamespace.on('connection', (socket) => {
    // Join a specific pad room
    socket.on('join_pad', (padId) => {
      const roomName = `pad_${padId}`;
      socket.join(roomName);
      
      // Let others know a new collaborator joined
      socket.to(roomName).emit('collaborator_joined', { socketId: socket.id });
    });

    // Handle Excalidraw element updates
    socket.on('pad_update', (data) => {
      const { padId, elements, appState } = data;
      // Broadcast to everyone else in the pad
      socket.to(`pad_${padId}`).emit('pad_update', {
        elements,
        appState,
        socketId: socket.id
      });
    });

    // Handle Excalidraw pointer/cursor updates
    socket.on('pointer_update', (data) => {
      const { padId, pointer, button, username } = data;
      socket.to(`pad_${padId}`).emit('pointer_update', {
        socketId: socket.id,
        pointer,
        button,
        username
      });
    });

    socket.on('leave_pad', (padId) => {
      const roomName = `pad_${padId}`;
      socket.leave(roomName);
      socket.to(roomName).emit('collaborator_left', { socketId: socket.id });
    });

    socket.on('disconnecting', () => {
      const rooms = Array.from(socket.rooms).filter(r => r.startsWith('pad_'));
      rooms.forEach(room => {
        socket.to(room).emit('collaborator_left', { socketId: socket.id });
      });
    });
  });
};
