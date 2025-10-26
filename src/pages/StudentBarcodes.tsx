import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { QrCode, Download, Printer, Search } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import Barcode from "react-barcode";

const StudentBarcodes = () => {
  const [students, setStudents] = useState([]);
  const [filteredStudents, setFilteredStudents] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");
  const { toast } = useToast();
  const printRef = useRef(null);

  useEffect(() => {
    fetchStudents();
  }, []);

  useEffect(() => {
    if (searchTerm) {
      setFilteredStudents(
        students.filter((student: any) =>
          student.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
          student.barcode_id?.toLowerCase().includes(searchTerm.toLowerCase())
        )
      );
    } else {
      setFilteredStudents(students);
    }
  }, [searchTerm, students]);

  const fetchStudents = async () => {
    try {
      const { data, error } = await supabase
        .from('students')
        .select('*')
        .eq('is_active', true)
        .order('name');

      if (error) throw error;
      setStudents(data || []);
      setFilteredStudents(data || []);
    } catch (error) {
      console.error('Error fetching students:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ في تحميل البيانات",
        variant: "destructive",
      });
    }
  };

  const handlePrint = () => {
    const printContent = printRef.current;
    if (!printContent) return;

    const printWindow = window.open('', '', 'width=800,height=600');
    printWindow?.document.write(`
      <html>
        <head>
          <title>بطاقات الطلاب</title>
          <style>
            @media print {
              @page { margin: 1cm; }
              body { font-family: Arial, sans-serif; }
            }
            body { 
              font-family: Arial, sans-serif; 
              direction: rtl;
              padding: 20px;
            }
            .card-grid {
              display: grid;
              grid-template-columns: repeat(2, 1fr);
              gap: 20px;
              page-break-inside: avoid;
            }
            .student-card {
              border: 2px solid #333;
              border-radius: 10px;
              padding: 20px;
              text-align: center;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              page-break-inside: avoid;
              height: 280px;
              display: flex;
              flex-direction: column;
              justify-content: space-between;
            }
            .student-name {
              font-size: 22px;
              font-weight: bold;
              margin-bottom: 10px;
            }
            .student-info {
              font-size: 14px;
              margin: 5px 0;
            }
            .barcode-container {
              background: white;
              padding: 10px;
              border-radius: 8px;
              margin: 10px 0;
            }
            .barcode-id {
              font-size: 12px;
              font-weight: bold;
              color: #333;
              margin-top: 5px;
            }
          </style>
        </head>
        <body>
          ${printContent.innerHTML}
        </body>
      </html>
    `);
    printWindow?.document.close();
    printWindow?.focus();
    setTimeout(() => {
      printWindow?.print();
      printWindow?.close();
    }, 250);
  };

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      <Header />
      
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <QrCode className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">بطاقات الطلاب بالباركود</h1>
              <p className="text-muted-foreground">عرض وطباعة بطاقات الطلاب مع الباركود</p>
            </div>
          </div>

          <Button onClick={handlePrint} className="bg-primary hover:bg-primary/90">
            <Printer className="ml-2 h-4 w-4" />
            طباعة جميع البطاقات
          </Button>
        </div>

        <Card className="shadow-soft mb-6">
          <CardHeader>
            <CardTitle>بحث عن طالب</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="relative">
              <Search className="absolute right-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="ابحث بالاسم أو رقم الباركود..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pr-10"
              />
            </div>
          </CardContent>
        </Card>

        <div ref={printRef} className="card-grid grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredStudents.map((student: any) => (
            <Card key={student.id} className="student-card shadow-lg overflow-hidden">
              <CardContent className="p-6">
                <div className="bg-gradient-primary rounded-t-lg p-4 -mx-6 -mt-6 mb-4">
                  <h2 className="text-xl font-bold text-white text-center">{student.name}</h2>
                </div>
                
                <div className="space-y-2 text-sm mb-4">
                  <p><span className="font-medium">الصف:</span> {student.grade || "غير محدد"}</p>
                  <p><span className="font-medium">الهاتف:</span> {student.phone || "غير محدد"}</p>
                </div>

                <div className="barcode-container bg-white p-3 rounded-lg border-2 border-primary/20">
                  {student.barcode_id && (
                    <div className="flex flex-col items-center">
                      <Barcode 
                        value={student.barcode_id} 
                        height={60}
                        width={2}
                        displayValue={true}
                        fontSize={12}
                        margin={5}
                      />
                    </div>
                  )}
                </div>

                <p className="text-xs text-center mt-2 text-muted-foreground">
                  امسح الباركود لتسجيل الحضور
                </p>
              </CardContent>
            </Card>
          ))}
        </div>

        {filteredStudents.length === 0 && (
          <Card>
            <CardContent className="p-12 text-center">
              <QrCode className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">لا توجد بطاقات لعرضها</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};

export default StudentBarcodes;
