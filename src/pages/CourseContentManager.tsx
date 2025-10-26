import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { FileText, Plus, Trash2, Upload, Video, FileImage } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import { supabase } from "@/integrations/supabase/client";

const CourseContentManager = () => {
  const [courses, setCourses] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [groups, setGroups] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [videoUrl, setVideoUrl] = useState("");
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    course_id: "",
    material_type: ""
  });
  
  const { toast } = useToast();

  useEffect(() => {
    fetchCourses();
    fetchMaterials();
    fetchGroups();
  }, []);


  const fetchCourses = async () => {
    try {
      const { data, error } = await supabase
        .from('courses')
        .select('*')
        .eq('is_active', true);
      
      if (error) throw error;
      setCourses(data || []);
    } catch (error) {
      console.error('Error fetching courses:', error);
    }
  };

  const fetchMaterials = async () => {
    try {
      const { data, error } = await supabase
        .from('course_materials')
        .select(`
          *,
          courses (
            id,
            name,
            subject
          )
        `)
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      setMaterials(data || []);
    } catch (error) {
      console.error('Error fetching materials:', error);
    }
  };

  const fetchGroups = async () => {
    try {
      const { data, error } = await supabase
        .from('groups')
        .select('*')
        .eq('is_active', true);
      
      if (error) throw error;
      setGroups(data || []);
    } catch (error) {
      console.error('Error fetching groups:', error);
    }
  };

  const handleFileUpload = async (file) => {
    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${Date.now()}-${file.name}`;
      const filePath = `${formData.course_id}/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('course-materials')
        .upload(filePath, file, {
          cacheControl: '3600',
          upsert: false
        });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('course-materials')
        .getPublicUrl(filePath);

      return { filePath, publicUrl, fileName: file.name };
    } catch (error) {
      console.error('Error uploading file:', error);
      throw error;
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    
    if (selectedGroups.length === 0) {
      toast({
        title: "خطأ",
        description: "يجب اختيار مجموعة واحدة على الأقل",
        variant: "destructive",
      });
      setLoading(false);
      return;
    }
    
    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      console.log('User check:', user, 'Error:', userError);
      
      if (!user) {
        console.error('No user found');
        throw new Error("يجب تسجيل الدخول أولاً");
      }
      
      console.log('User ID:', user.id);

      let fileUrl = "";
      let fileName = "";
      let filePath = "";

      // For videos, use Google Drive link if provided
      if (formData.material_type === 'video' && videoUrl) {
        fileUrl = videoUrl;
        fileName = "رابط فيديو";
      } else if (uploadFile) {
        const uploadResult = await handleFileUpload(uploadFile);
        fileUrl = uploadResult.publicUrl;
        fileName = uploadResult.fileName;
        filePath = uploadResult.filePath;
      }

      console.log('Inserting material with data:', {
        course_id: formData.course_id,
        title: formData.title,
        uploaded_by: user.id
      });

      const { data: materialData, error } = await supabase
        .from('course_materials')
        .insert({
          course_id: formData.course_id,
          title: formData.title,
          description: formData.description,
          material_type: formData.material_type,
          file_path: filePath,
          file_name: fileName,
          file_url: fileUrl,
          uploaded_by: user.id,
          file_size: uploadFile ? uploadFile.size : null
        })
        .select()
        .single();

      console.log('Insert result:', materialData, 'Error:', error);

      if (error) {
        console.error('Insert error:', error);
        throw error;
      }

      // Insert material-group relationships
      for (const groupId of selectedGroups) {
        await supabase
          .from('material_groups')
          .insert({
            material_id: materialData.id,
            group_id: groupId
          });
      }

      toast({
        title: "تم الإضافة بنجاح",
        description: "تم إضافة المحتوى وربطه بالمجموعات المحددة",
      });

      fetchMaterials();
      setIsOpen(false);
      setSelectedGroups([]);
      setFormData({ title: "", description: "", course_id: "", material_type: "" });
      setUploadFile(null);
      setVideoUrl("");
    } catch (error) {
      console.error('Error:', error);
      toast({
        title: "خطأ",
        description: error.message || "حدث خطأ، حاول مرة أخرى",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id, filePath) => {
    try {
      // Delete file from storage
      if (filePath) {
        await supabase.storage
          .from('course-materials')
          .remove([filePath]);
      }

      // Delete record from database
      const { error } = await supabase
        .from('course_materials')
        .delete()
        .eq('id', id);
      
      if (error) throw error;
      
      fetchMaterials();
      toast({
        title: "تم الحذف بنجاح",
        description: "تم حذف المحتوى",
      });
    } catch (error) {
      toast({
        title: "خطأ",
        description: "حدث خطأ في الحذف",
        variant: "destructive",
      });
    }
  };

  const getMaterialIcon = (type) => {
    switch (type) {
      case 'pdf':
        return <FileText className="w-5 h-5 text-red-500" />;
      case 'presentation':
        return <FileImage className="w-5 h-5 text-blue-500" />;
      case 'video':
        return <Video className="w-5 h-5 text-green-500" />;
      default:
        return <FileText className="w-5 h-5 text-gray-500" />;
    }
  };

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      <Header />
      
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <FileText className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">إدارة المحتوى التعليمي</h1>
              <p className="text-muted-foreground">إضافة وإدارة محتويات الكورسات</p>
            </div>
          </div>
          
          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
              <Button className="shadow-medium">
                <Plus className="w-4 h-4 ml-2" />
                إضافة محتوى جديد
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>إضافة محتوى تعليمي جديد</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="course">الكورس</Label>
                  <Select value={formData.course_id} onValueChange={(value) => setFormData(prev => ({ ...prev, course_id: value }))}>
                    <SelectTrigger>
                      <SelectValue placeholder="اختر الكورس" />
                    </SelectTrigger>
                    <SelectContent>
                      {courses.map((course) => (
                        <SelectItem key={course.id} value={course.id}>
                          {course.name} - {course.subject}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="title">عنوان المحتوى</Label>
                  <Input
                    id="title"
                    value={formData.title}
                    onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                    placeholder="أدخل عنوان المحتوى"
                    required
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="description">الوصف</Label>
                  <Input
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="وصف المحتوى (اختياري)"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="material_type">نوع المحتوى</Label>
                  <Select 
                    value={formData.material_type} 
                    onValueChange={(value) => {
                      setFormData(prev => ({ ...prev, material_type: value }));
                      setUploadFile(null);
                      setVideoUrl("");
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="اختر نوع المحتوى" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pdf">ملف PDF</SelectItem>
                      <SelectItem value="presentation">عرض تقديمي</SelectItem>
                      <SelectItem value="video">فيديو</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                {formData.material_type === 'video' ? (
                  <div className="space-y-2">
                    <Label htmlFor="video_url">رابط Google Drive للفيديو</Label>
                    <Input
                      id="video_url"
                      type="url"
                      value={videoUrl}
                      onChange={(e) => setVideoUrl(e.target.value)}
                      placeholder="https://drive.google.com/..."
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      أدخل رابط الفيديو من Google Drive
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="file">رفع الملف</Label>
                    <Input
                      id="file"
                      type="file"
                      onChange={(e) => {
                        const file = e.target.files[0];
                        if (file) {
                          const maxSize = 500 * 1024 * 1024; // 500MB
                          if (file.size > maxSize) {
                            toast({
                              title: "خطأ",
                              description: "حجم الملف يتجاوز الحد الأقصى المسموح به (500 ميجابايت)",
                              variant: "destructive",
                            });
                            e.target.value = '';
                            return;
                          }
                          setUploadFile(file);
                        }
                      }}
                      accept={
                        formData.material_type === 'pdf' ? '.pdf' :
                        formData.material_type === 'presentation' ? '.ppt,.pptx,.pptm,.odp' :
                        '.pdf,.ppt,.pptx'
                      }
                      required
                      disabled={!formData.material_type}
                    />
                    {!formData.material_type && (
                      <p className="text-xs text-muted-foreground">الرجاء اختيار نوع المحتوى أولاً</p>
                    )}
                    {formData.material_type && (
                      <p className="text-xs text-muted-foreground">
                        {formData.material_type === 'pdf' && 'يمكنك رفع ملفات PDF (الحد الأقصى 500 ميجابايت)'}
                        {formData.material_type === 'presentation' && 'يمكنك رفع ملفات PowerPoint (الحد الأقصى 500 ميجابايت)'}
                      </p>
                    )}
                    {uploadFile && (
                      <p className="text-xs text-muted-foreground">
                        حجم الملف: {(uploadFile.size / (1024 * 1024)).toFixed(2)} ميجابايت
                      </p>
                    )}
                  </div>
                )}
                
                <div className="space-y-2">
                  <Label>المجموعات المستهدفة</Label>
                  <div className="space-y-2 max-h-40 overflow-y-auto border rounded-md p-3">
                    {groups.map((group) => (
                      <div key={group.id} className="flex items-center space-x-2 space-x-reverse">
                        <Checkbox
                          id={`group-${group.id}`}
                          checked={selectedGroups.includes(group.id)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setSelectedGroups([...selectedGroups, group.id]);
                            } else {
                              setSelectedGroups(selectedGroups.filter(id => id !== group.id));
                            }
                          }}
                        />
                        <Label htmlFor={`group-${group.id}`} className="text-sm font-normal">
                          {group.name}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
                
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "جاري الرفع..." : "إضافة المحتوى"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <Card className="shadow-soft">
          <CardHeader>
            <CardTitle>المحتويات التعليمية</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>المحتوى</TableHead>
                  <TableHead>الكورس</TableHead>
                  <TableHead>النوع</TableHead>
                  <TableHead>تاريخ الإضافة</TableHead>
                  <TableHead>الإجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {materials.map((material) => (
                  <TableRow key={material.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {getMaterialIcon(material.material_type)}
                        <div>
                          <p className="font-medium">{material.title}</p>
                          {material.description && (
                            <p className="text-sm text-muted-foreground">{material.description}</p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{material.courses?.name} - {material.courses?.subject}</TableCell>
                    <TableCell>
                      <span className="px-2 py-1 bg-primary/10 text-primary rounded text-xs">
                        {material.material_type === 'pdf' ? 'PDF' : 
                         material.material_type === 'presentation' ? 'عرض تقديمي' : 
                         material.material_type === 'video' ? 'فيديو' : 'غير محدد'}
                      </span>
                    </TableCell>
                    <TableCell>{new Date(material.created_at).toLocaleDateString('ar-SA')}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {material.file_url && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => window.open(material.file_url, '_blank')}
                          >
                            <Upload className="w-4 h-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(material.id, material.file_path)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default CourseContentManager;