/** Private in-memory identity comparison; never persisted or logged. */
export const readSupportSessionIdentity = () => {
  try {
    if(!localStorage.getItem('authToken'))return null;
    return JSON.stringify(['authToken','currentUser','currentStudent','currentStudentSpace','student_session','offlineStudentSession'].map(key=>localStorage.getItem(key)));
  }catch{return null;}
};
