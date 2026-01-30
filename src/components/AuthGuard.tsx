import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';

interface AuthGuardProps {
    children: React.ReactNode;
    requiredRole?: 'student' | 'teacher' | 'admin' | 'staff';
}

// Map of route paths to permission IDs
const ROUTE_TO_PERMISSION: Record<string, string> = {
    '/students': 'students',
    '/offline-students': 'students',
    '/registration-requests': 'students',
    '/courses': 'courses',
    '/groups': 'groups',
    '/grades': 'groups',
    '/attendance': 'attendance',
    '/barcode-attendance': 'attendance',
    '/attendance-log': 'attendance',
    '/fees': 'fees',
    '/student-payments': 'fees',
    '/messages': 'messages',
    '/chat-assistant': 'messages',
    '/reports': 'reports',
    '/student-reports': 'reports',
    '/expenses': 'expenses',
    '/account-statement': 'expenses',
    '/imports': 'expenses',
    '/profits': 'expenses',
};

export const AuthGuard = ({ children, requiredRole }: AuthGuardProps) => {
    const { toast } = useToast();
    const location = useLocation();
    const [isChecking, setIsChecking] = useState(true);
    const [isAuthorized, setIsAuthorized] = useState(false);

    useEffect(() => {
        const checkAuth = () => {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('🔍 AuthGuard: Starting authentication check');
            console.log('🔍 Required Role:', requiredRole || 'any');
            console.log('🔍 Current Path:', location.pathname);

            const userStr = localStorage.getItem('currentUser');
            console.log('🔍 Raw localStorage data:', userStr);

            if (!userStr) {
                console.log('❌ AuthGuard: No user found in localStorage');
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                toast({
                    variant: "destructive",
                    title: "غير مسموح",
                    description: "يرجى تسجيل الدخول أولاً",
                });
                setIsAuthorized(false);
                setIsChecking(false);
                return;
            }

            try {
                const user = JSON.parse(userStr);
                console.log('✅ User parsed successfully');
                console.log('👤 User ID:', user.id);
                console.log('👤 User Name:', user.name);
                console.log('👤 User Role:', user.role);
                console.log('🎯 Required Role:', requiredRole);
                console.log('🔄 Is Admin?', user.role === 'admin');

                // Admin has access to all pages
                if (user.role === 'admin') {
                    console.log('✅ AuthGuard: Admin has full access');
                    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                    setIsAuthorized(true);
                    setIsChecking(false);
                    return;
                }

                // Staff role - check page permissions
                if (user.role === 'staff') {
                    console.log('👤 Staff user detected, checking permissions...');
                    const accessiblePages: string[] = user.accessible_pages || [];
                    console.log('📋 Accessible pages:', accessiblePages);

                    // Get required permission for current route
                    const currentPath = location.pathname;
                    const requiredPermission = ROUTE_TO_PERMISSION[currentPath];

                    console.log('🔍 Required permission for path:', requiredPermission);

                    // If no specific permission required for this page (like /teacher dashboard)
                    // Staff can access if they have any permissions
                    if (!requiredPermission) {
                        // Allow access to base teacher dashboard if staff has any permissions
                        if (currentPath === '/teacher' && accessiblePages.length > 0) {
                            console.log('✅ Staff has permissions, allowing teacher dashboard access');
                            setIsAuthorized(true);
                            setIsChecking(false);
                            return;
                        }
                        // If it's a page without specific mapping and not teacher dashboard
                        console.log('❌ No permission mapping for this page');
                        toast({
                            variant: "destructive",
                            title: "غير مسموح",
                            description: "ليس لديك صلاحية للوصول لهذه الصفحة",
                        });
                        setIsAuthorized(false);
                        setIsChecking(false);
                        return;
                    }

                    // Check if staff has required permission
                    if (accessiblePages.includes(requiredPermission)) {
                        console.log('✅ Staff has permission:', requiredPermission);
                        setIsAuthorized(true);
                        setIsChecking(false);
                        return;
                    } else {
                        console.log('❌ Staff does NOT have permission:', requiredPermission);
                        toast({
                            variant: "destructive",
                            title: "غير مسموح",
                            description: "ليس لديك صلاحية للوصول لهذه الصفحة",
                        });
                        setIsAuthorized(false);
                        setIsChecking(false);
                        return;
                    }
                }

                // Check if user has required role
                // Teacher can access teacher pages
                if (requiredRole === 'teacher' && (user.role === 'teacher')) {
                    console.log('✅ AuthGuard: Teacher access granted');
                    setIsAuthorized(true);
                    setIsChecking(false);
                    return;
                }

                // Student can access student pages
                if (requiredRole === 'student' && user.role === 'student') {
                    console.log('✅ AuthGuard: Student access granted');
                    setIsAuthorized(true);
                    setIsChecking(false);
                    return;
                }

                // Role mismatch
                if (requiredRole && user.role !== requiredRole) {
                    console.log('❌ AuthGuard: Role check FAILED');
                    console.log('   User role:', user.role);
                    console.log('   Required role:', requiredRole);
                    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                    toast({
                        variant: "destructive",
                        title: "غير مسموح",
                        description: `هذه الصفحة لـ ${requiredRole === 'teacher' ? 'المعلمين' : 'الطلاب'} فقط`,
                    });
                    setIsAuthorized(false);
                    setIsChecking(false);
                    return;
                }

                console.log('✅ AuthGuard: Authorization check PASSED!');
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                setIsAuthorized(true);
                setIsChecking(false);
            } catch (error) {
                console.error('❌ AuthGuard: Error parsing user data:', error);
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                toast({
                    variant: "destructive",
                    title: "خطأ",
                    description: "حدث خطأ في التحقق من بيانات المستخدم",
                });
                setIsAuthorized(false);
                setIsChecking(false);
            }
        };

        checkAuth();
    }, [toast, requiredRole, location.pathname]);

    // Show nothing while checking
    if (isChecking) {
        return null;
    }

    // Redirect to auth if not authorized
    if (!isAuthorized) {
        return <Navigate to="/auth" replace />;
    }

    // Show content if authorized
    return <>{children}</>;
};

export default AuthGuard;
