import React, { useState, useEffect } from 'react';
import Header from '@/components/Header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { QrCode, Users, Calendar, Clock, RefreshCw } from 'lucide-react';

interface Group {
  id: string;
  name: string;
}

interface QRCode {
  id: string;
  code: string;
  group_id: string;
  session_date: string;
  expires_at: string;
  is_active: boolean;
  groups?: { name: string };
}

const QRAttendance = () => {
  const [groups, setGroups] = useState<Group[]>([]);
  const [qrCodes, setQRCodes] = useState<QRCode[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetchGroups();
    fetchQRCodes();
  }, []);

  const fetchGroups = async () => {
    try {
      const { data, error } = await supabase
        .from('groups')
        .select(`
          id, 
          name
        `)
        .eq('is_active', true);

      if (error) throw error;
      setGroups(data || []);
    } catch (error) {
      console.error('Error fetching groups:', error);
      toast({
        title: "خطأ",
        description: "فشل في تحميل المجموعات",
        variant: "destructive",
      });
    }
  };

  const fetchQRCodes = async () => {
    try {
      const { data, error } = await supabase
        .from('attendance_qr_codes')
        .select(`
          *,
          groups (
            name
          )
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setQRCodes(data || []);
    } catch (error) {
      console.error('Error fetching QR codes:', error);
    }
  };

  const generateQRCode = async () => {
    if (!selectedGroupId) {
      toast({
        title: "خطأ",
        description: "يرجى اختيار مجموعة أولاً",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    try {
      // Generate a unique code
      const qrCode = `ATT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      const { error } = await supabase
        .from('attendance_qr_codes')
        .insert([{
          code: qrCode,
          group_id: selectedGroupId,
          session_date: new Date().toISOString().split('T')[0],
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours from now
          is_active: true
        }]);

      if (error) throw error;

      toast({
        title: "نجح",
        description: "تم إنشاء رمز QR للحضور بنجاح",
      });

      fetchQRCodes();
    } catch (error) {
      console.error('Error generating QR code:', error);
      toast({
        title: "خطأ",
        description: "فشل في إنشاء رمز QR",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const deactivateQRCode = async (id: string) => {
    try {
      const { error } = await supabase
        .from('attendance_qr_codes')
        .update({ is_active: false })
        .eq('id', id);

      if (error) throw error;

      toast({
        title: "نجح",
        description: "تم إلغاء تفعيل رمز QR",
      });

      fetchQRCodes();
    } catch (error) {
      console.error('Error deactivating QR code:', error);
      toast({
        title: "خطأ",
        description: "فشل في إلغاء تفعيل رمز QR",
        variant: "destructive",
      });
    }
  };

  const isExpired = (expiresAt: string) => {
    return new Date(expiresAt) < new Date();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-indigo-900">
      <Header />
      
      <main className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold text-white mb-2">إدارة الحضور بـ QR Code</h1>
            <p className="text-slate-300">إنشاء وإدارة رموز QR للحضور والغياب</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          <Card className="bg-white/10 backdrop-blur-sm border-white/20">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <QrCode className="h-5 w-5" />
                إنشاء رمز QR جديد
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-white text-sm font-medium mb-2 block">
                  اختر المجموعة
                </label>
                <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
                  <SelectTrigger className="bg-white/10 border-white/20 text-white">
                    <SelectValue placeholder="اختر المجموعة" />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        <div className="flex items-center gap-2">
                          <Users className="h-4 w-4" />
                          {group.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button
                onClick={generateQRCode}
                disabled={loading || !selectedGroupId}
                className="w-full bg-blue-600 hover:bg-blue-700"
              >
                {loading ? (
                  <RefreshCw className="h-4 w-4 animate-spin ml-2" />
                ) : (
                  <QrCode className="h-4 w-4 ml-2" />
                )}
                إنشاء رمز QR للحضور
              </Button>
            </CardContent>
          </Card>

          <Card className="bg-white/10 backdrop-blur-sm border-white/20">
            <CardHeader>
              <CardTitle className="text-white">معلومات الحضور</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4 text-white">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-blue-400" />
                  <span>التاريخ: {new Date().toLocaleDateString('ar-EG')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-blue-400" />
                  <span>الوقت: {new Date().toLocaleTimeString('ar-EG')}</span>
                </div>
                <div className="p-4 bg-blue-600/20 rounded-lg">
                  <h3 className="font-medium mb-2">كيفية استخدام QR Code:</h3>
                  <ul className="text-sm space-y-1 text-slate-300">
                    <li>• اختر المجموعة وأنشئ رمز QR</li>
                    <li>• اعرض الرمز للطلاب ليسجلوا الحضور</li>
                    <li>• الرمز صالح لمدة 24 ساعة</li>
                    <li>• يمكن إلغاء تفعيل الرمز في أي وقت</li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="bg-white/10 backdrop-blur-sm border-white/20">
          <CardHeader>
            <CardTitle className="text-white">رموز QR المُنشأة</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-white">رمز QR</TableHead>
                  <TableHead className="text-white">المجموعة</TableHead>
                  <TableHead className="text-white">تاريخ الجلسة</TableHead>
                  <TableHead className="text-white">ينتهي في</TableHead>
                  <TableHead className="text-white">الحالة</TableHead>
                  <TableHead className="text-white">الإجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {qrCodes.map((qr) => (
                  <TableRow key={qr.id}>
                    <TableCell className="text-white font-mono text-sm">
                      {qr.code}
                    </TableCell>
                    <TableCell className="text-white">
                      {qr.groups?.name || 'غير محدد'}
                    </TableCell>
                    <TableCell className="text-white">
                      {new Date(qr.session_date).toLocaleDateString('ar-EG')}
                    </TableCell>
                    <TableCell className="text-white">
                      {new Date(qr.expires_at).toLocaleString('ar-EG')}
                    </TableCell>
                    <TableCell>
                      <Badge 
                        variant={
                          !qr.is_active ? "secondary" :
                          isExpired(qr.expires_at) ? "destructive" : 
                          "default"
                        }
                      >
                        {!qr.is_active ? 'غير نشط' :
                         isExpired(qr.expires_at) ? 'منتهي الصلاحية' : 
                         'نشط'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {qr.is_active && !isExpired(qr.expires_at) && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => deactivateQRCode(qr.id)}
                          className="text-red-600 border-red-600 hover:bg-red-600 hover:text-white"
                        >
                          إلغاء التفعيل
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default QRAttendance;