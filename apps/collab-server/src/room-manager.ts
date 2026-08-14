import * as Y from 'yjs';

export interface Room {
  documentId: string;
  doc: Y.Doc;
  connections: Set<unknown>;
}

const rooms = new Map<string, Room>();

export function getOrCreateRoom(documentId: string): Room {
  let room = rooms.get(documentId);
  if (!room) {
    room = {
      documentId,
      doc: new Y.Doc(),
      connections: new Set(),
    };
    rooms.set(documentId, room);
  }
  return room;
}

export function removeRoomIfEmpty(documentId: string): void {
  const room = rooms.get(documentId);
  if (room && room.connections.size === 0) {
    rooms.delete(documentId);
  }
}
