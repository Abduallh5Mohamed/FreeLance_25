import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Clock, CheckCircle, XCircle } from "lucide-react";
import { useParams, useNavigate } from "react-router-dom";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import { supabase } from "@/integrations/supabase/client";

const TakeExam = () => {
  const { examId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  
  const [exam, setExam] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [student, setStudent] = useState(null);
  const [answers, setAnswers] = useState({});
  const [timeLeft, setTimeLeft] = useState(0);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    fetchExamData();
    getCurrentStudent();
  }, [examId]);

  useEffect(() => {
    if (timeLeft > 0 && !isSubmitted) {
      const timer = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
      return () => clearTimeout(timer);
    } else if (timeLeft === 0 && exam && !isSubmitted) {
      handleSubmit();
    }
  }, [timeLeft, isSubmitted, exam]);

  const getCurrentStudent = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        navigate('/auth');
        return;
      }

      const { data: studentData, error } = await supabase
        .from('students')
        .select('*')
        .eq('email', user.email)
        .single();
      
      if (error || !studentData) {
        toast({
          title: "خطأ",
          description: "لا يمكن العثور على بيانات الطالب",
          variant: "destructive",
        });
        navigate('/student');
        return;
      }

      setStudent(studentData);
    } catch (error) {
      console.error('Error fetching student:', error);
    }
  };

  const fetchExamData = async () => {
    try {
      const { data: examData, error: examError } = await supabase
        .from('exams')
        .select(`
          *,
          courses (
            id,
            name,
            subject
          )
        `)
        .eq('id', examId)
        .single();
      
      if (examError) throw examError;
      setExam(examData);
      setTimeLeft(examData.duration_minutes * 60);

      const { data: questionsData, error: questionsError } = await supabase
        .from('exam_questions')
        .select('*')
        .eq('exam_id', examId)
        .order('created_at');
      
      if (questionsError) throw questionsError;
      setQuestions(questionsData || []);
    } catch (error) {
      console.error('Error fetching exam:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ في تحميل الامتحان",
        variant: "destructive",
      });
    }
  };

  const handleAnswerChange = (questionId, answer) => {
    setAnswers(prev => ({
      ...prev,
      [questionId]: answer
    }));
  };

  const calculateScore = () => {
    let correctAnswers = 0;
    let totalPoints = 0;
    let earnedPoints = 0;

    questions.forEach(question => {
      totalPoints += question.points;
      if (answers[question.id] === question.correct_answer) {
        correctAnswers++;
        earnedPoints += question.points;
      }
    });

    return {
      correctAnswers,
      totalQuestions: questions.length,
      earnedPoints,
      totalPoints,
      percentage: Math.round((earnedPoints / totalPoints) * 100)
    };
  };

  const handleSubmit = async () => {
    if (!student) return;
    
    setLoading(true);
    
    try {
      // Calculate results
      const results = calculateScore();
      
      // Save answers to database
      for (const questionId in answers) {
        const question = questions.find(q => q.id === questionId);
        const isCorrect = answers[questionId] === question.correct_answer;
        
        await supabase
          .from('exam_student_answers')
          .upsert({
            exam_id: examId,
            student_id: student.id,
            question_id: questionId,
            student_answer: answers[questionId],
            is_correct: isCorrect
          });
      }

      // Save exam result
      await supabase
        .from('exam_results')
        .upsert({
          exam_id: examId,
          student_id: student.id,
          marks_obtained: results.earnedPoints,
          grade: results.percentage >= 85 ? 'ممتاز' : 
                 results.percentage >= 75 ? 'جيد جداً' :
                 results.percentage >= 65 ? 'جيد' :
                 results.percentage >= 50 ? 'مقبول' : 'راسب'
        });

      setResult(results);
      setIsSubmitted(true);
      
      toast({
        title: "تم تسليم الامتحان",
        description: `حصلت على ${results.earnedPoints} من ${results.totalPoints} درجة`,
      });
    } catch (error) {
      console.error('Error submitting exam:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ في تسليم الامتحان",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  if (!exam || !student) {
    return <div className="min-h-screen bg-background flex items-center justify-center">جاري التحميل...</div>;
  }

  if (isSubmitted && result) {
    return (
      <div className="min-h-screen bg-background" dir="rtl">
        <Header />
        <div className="container mx-auto px-4 py-8">
          <Card className="max-w-2xl mx-auto">
            <CardHeader className="text-center">
              <CardTitle className="text-2xl">نتيجة الامتحان</CardTitle>
              <p className="text-muted-foreground">{exam.title}</p>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="text-center">
                <div className="text-4xl font-bold text-primary mb-2">
                  {result.percentage}%
                </div>
                <p className="text-lg text-muted-foreground">
                  {result.earnedPoints} من {result.totalPoints} درجة
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4 text-center">
                <div className="flex items-center justify-center gap-2">
                  <CheckCircle className="w-5 h-5 text-green-500" />
                  <span>إجابات صحيحة: {result.correctAnswers}</span>
                </div>
                <div className="flex items-center justify-center gap-2">
                  <XCircle className="w-5 h-5 text-red-500" />
                  <span>إجابات خاطئة: {result.totalQuestions - result.correctAnswers}</span>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="font-medium">مراجعة الإجابات:</h3>
                {questions.map((question, index) => (
                  <Card key={question.id} className="p-4">
                    <p className="font-medium mb-2">
                      س{index + 1}: {question.question_text}
                    </p>
                    <div className="space-y-1 text-sm">
                      <p className="text-green-600">
                        الإجابة الصحيحة: {question.correct_answer}
                      </p>
                      <p className={answers[question.id] === question.correct_answer ? "text-green-600" : "text-red-500"}>
                        إجابتك: {answers[question.id] || "لم تجب"}
                      </p>
                    </div>
                  </Card>
                ))}
              </div>

              <Button onClick={() => navigate('/student')} className="w-full">
                العودة للوحة الطالب
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      <Header />
      
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          <Card className="mb-6">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-xl">{exam.title}</CardTitle>
                  <p className="text-muted-foreground">
                    {exam.courses?.name} - {exam.courses?.subject}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-lg font-medium">
                  <Clock className="w-5 h-5" />
                  <span className={timeLeft < 300 ? "text-red-500" : ""}> {/* Last 5 minutes in red */}
                    {formatTime(timeLeft)}
                  </span>
                </div>
              </div>
            </CardHeader>
          </Card>

          <div className="space-y-6">
            {questions.map((question, index) => (
              <Card key={question.id}>
                <CardContent className="pt-6">
                  <div className="space-y-4">
                    <h3 className="font-medium text-lg">
                      س{index + 1}: {question.question_text}
                      <span className="text-sm text-muted-foreground mr-2">
                        ({question.points} نقطة)
                      </span>
                    </h3>

                    {question.question_type === 'multiple_choice' && question.options ? (
                      <RadioGroup
                        value={answers[question.id] || ""}
                        onValueChange={(value) => handleAnswerChange(question.id, value)}
                      >
                        {question.options.map((option, optIndex) => (
                          <div key={optIndex} className="flex items-center space-x-2 space-x-reverse">
                            <RadioGroupItem value={option} id={`${question.id}-${optIndex}`} />
                            <Label htmlFor={`${question.id}-${optIndex}`} className="text-base">
                              {String.fromCharCode(65 + optIndex)}) {option}
                            </Label>
                          </div>
                        ))}
                      </RadioGroup>
                    ) : (
                      <Input
                        value={answers[question.id] || ""}
                        onChange={(e) => handleAnswerChange(question.id, e.target.value)}
                        placeholder="اكتب إجابتك هنا..."
                        className="text-right"
                      />
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="mt-8 text-center">
            <Button 
              onClick={handleSubmit} 
              size="lg" 
              disabled={loading}
              className="min-w-[200px]"
            >
              {loading ? "جاري التسليم..." : "تسليم الامتحان"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TakeExam;