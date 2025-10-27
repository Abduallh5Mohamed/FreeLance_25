/* eslint-disable @typescript-eslint/no-explicit-any */
// Mock Database for Browser Environment
// This provides localStorage-based data storage until we set up a proper backend API

const STORAGE_KEYS = {
    USERS: 'mock_users',
    STUDENTS: 'mock_students',
    COURSES: 'mock_courses',
    GROUPS: 'mock_groups',
    GRADES: 'mock_grades',
    EXAMS: 'mock_exams',
    ATTENDANCE: 'mock_attendance',
};

// Initialize default data
const initializeDefaultData = () => {
    if (!localStorage.getItem(STORAGE_KEYS.USERS)) {
        const defaultUser = {
            id: '1',
            email: 'hodabdh3@gmail.com',
            name: 'الأستاذ محمد رمضان',
            role: 'admin',
            is_active: true,
            password_hash: '$2a$10$YourHashedPasswordHere', // This is a placeholder
        };
        localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify([defaultUser]));
    }

    if (!localStorage.getItem(STORAGE_KEYS.GRADES)) {
        const defaultGrades = [
            { id: '1', name: 'الصف الأول الثانوي', display_order: 1, is_active: true },
            { id: '2', name: 'الصف الثاني الثانوي', display_order: 2, is_active: true },
            { id: '3', name: 'الصف الثالث الثانوي', display_order: 3, is_active: true },
        ];
        localStorage.setItem(STORAGE_KEYS.GRADES, JSON.stringify(defaultGrades));
    }

    if (!localStorage.getItem(STORAGE_KEYS.GROUPS)) {
        const defaultGroups = [
            { id: '1', name: 'الصف الأول الثانوي', description: 'مجموعة الصف الأول الثانوي', is_active: true, max_students: 50, current_students: 0 },
            { id: '2', name: 'الصف الثاني الثانوي', description: 'مجموعة الصف الثاني الثانوي', is_active: true, max_students: 50, current_students: 0 },
            { id: '3', name: 'الصف الثالث الثانوي', description: 'مجموعة الصف الثالث الثانوي', is_active: true, max_students: 50, current_students: 0 },
        ];
        localStorage.setItem(STORAGE_KEYS.GROUPS, JSON.stringify(defaultGroups));
    }

    if (!localStorage.getItem(STORAGE_KEYS.STUDENTS)) {
        localStorage.setItem(STORAGE_KEYS.STUDENTS, JSON.stringify([]));
    }

    if (!localStorage.getItem(STORAGE_KEYS.COURSES)) {
        localStorage.setItem(STORAGE_KEYS.COURSES, JSON.stringify([]));
    }

    if (!localStorage.getItem(STORAGE_KEYS.EXAMS)) {
        localStorage.setItem(STORAGE_KEYS.EXAMS, JSON.stringify([]));
    }

    if (!localStorage.getItem(STORAGE_KEYS.ATTENDANCE)) {
        localStorage.setItem(STORAGE_KEYS.ATTENDANCE, JSON.stringify([]));
    }
};

// Helper to generate UUIDs
const generateId = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
};

// Generic CRUD operations
export const mockQuery = <T = any>(table: string, filter?: (item: any) => boolean): T[] => {
    initializeDefaultData();
    const key = STORAGE_KEYS[table as keyof typeof STORAGE_KEYS];
    if (!key) return [];

    const data = JSON.parse(localStorage.getItem(key) || '[]');
    return filter ? data.filter(filter) : data;
};

export const mockQueryOne = <T = any>(table: string, filter: (item: any) => boolean): T | null => {
    const results = mockQuery<T>(table, filter);
    return results.length > 0 ? results[0] : null;
};

export const mockInsert = (table: string, data: any): string => {
    initializeDefaultData();
    const key = STORAGE_KEYS[table as keyof typeof STORAGE_KEYS];
    if (!key) throw new Error(`Unknown table: ${table}`);

    const items = JSON.parse(localStorage.getItem(key) || '[]');
    const newItem = { ...data, id: data.id || generateId() };
    items.push(newItem);
    localStorage.setItem(key, JSON.stringify(items));
    return newItem.id;
};

export const mockUpdate = (table: string, id: string, data: any): boolean => {
    initializeDefaultData();
    const key = STORAGE_KEYS[table as keyof typeof STORAGE_KEYS];
    if (!key) return false;

    const items = JSON.parse(localStorage.getItem(key) || '[]');
    const index = items.findIndex((item: any) => item.id === id);

    if (index === -1) return false;

    items[index] = { ...items[index], ...data };
    localStorage.setItem(key, JSON.stringify(items));
    return true;
};

export const mockDelete = (table: string, id: string): boolean => {
    initializeDefaultData();
    const key = STORAGE_KEYS[table as keyof typeof STORAGE_KEYS];
    if (!key) return false;

    const items = JSON.parse(localStorage.getItem(key) || '[]');
    const filtered = items.filter((item: any) => item.id !== id);

    if (filtered.length === items.length) return false;

    localStorage.setItem(key, JSON.stringify(filtered));
    return true;
};

// Initialize on module load
initializeDefaultData();

export default {
    query: mockQuery,
    queryOne: mockQueryOne,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
};
