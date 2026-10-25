import { Navigate } from 'react-router-dom';

// This legacy entry previously fabricated teacher replies locally.
// The existing authenticated messaging page resolves server-authorized contacts.
export default function TeacherChat() {
  return <Navigate to="/student-chat" replace />;
}
