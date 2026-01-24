import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';

interface AuthGuardProps {
    children: React.ReactNode;
    requiredRole?: 'student' | 'teacher' | 'admin';
}

export const AuthGuard = ({ children, requiredRole }: AuthGuardProps) => {
    const { toast } = useToast();
    const [isChecking, setIsChecking] = useState(true);
    const [isAuthorized, setIsAuthorized] = useState(false);

    useEffect(() => {
        const checkAuth = () => {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('🔍 AuthGuard: Starting authentication check');
            console.log('🔍 Required Role:', requiredRole || 'any');

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

                // Check if user has required role
                // Admin has access to all pages (teacher and student)
                if (requiredRole && user.role !== requiredRole && user.role !== 'admin') {
                    console.log('❌ AuthGuard: Role check FAILED');
                    console.log('   User role:', user.role);
                    console.log('   Required role:', requiredRole);
                    console.log('   Is admin:', user.role === 'admin');
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
    }, [toast, requiredRole]);

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
