-- إضافة دور admin للمستخدم محمد رمضان
INSERT INTO public.user_roles (user_id, role)
VALUES ('7464daff-b429-4dfd-b313-f319622a066a', 'admin')
ON CONFLICT (user_id, role) DO NOTHING;