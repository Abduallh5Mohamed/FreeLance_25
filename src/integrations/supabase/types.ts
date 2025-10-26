export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "12.2.3 (519615d)"
  }
  public: {
    Tables: {
      account_statement: {
        Row: {
          amount: number
          created_at: string | null
          description: string | null
          id: string
          payment_date: string
          student_id: string | null
          subscription_id: string | null
        }
        Insert: {
          amount: number
          created_at?: string | null
          description?: string | null
          id?: string
          payment_date: string
          student_id?: string | null
          subscription_id?: string | null
        }
        Update: {
          amount?: number
          created_at?: string | null
          description?: string | null
          id?: string
          payment_date?: string
          student_id?: string | null
          subscription_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "account_statement_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_statement_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_verification_codes: {
        Row: {
          code: string
          created_at: string
          device_info: string | null
          email: string
          expires_at: string
          id: string
          used: boolean | null
        }
        Insert: {
          code: string
          created_at?: string
          device_info?: string | null
          email: string
          expires_at?: string
          id?: string
          used?: boolean | null
        }
        Update: {
          code?: string
          created_at?: string
          device_info?: string | null
          email?: string
          expires_at?: string
          id?: string
          used?: boolean | null
        }
        Relationships: []
      }
      advance_payment_invoices: {
        Row: {
          cash_amount: number | null
          cashier_name: string | null
          created_at: string | null
          customer_address: string | null
          customer_name: string
          customer_phone: string | null
          date: string | null
          discount_percentage: number | null
          has_partial_return: boolean | null
          id: string
          invoice_number: number
          items: Json
          notes: string | null
          partial_return_amount: number | null
          payment_method: string | null
          representative_code: string | null
          representative_name: string | null
          status: string | null
          time: string | null
          total_advance_amount: number
          total_amount: number
          total_remaining_amount: number
          updated_at: string | null
          visa_amount: number | null
          visa_details: string | null
        }
        Insert: {
          cash_amount?: number | null
          cashier_name?: string | null
          created_at?: string | null
          customer_address?: string | null
          customer_name: string
          customer_phone?: string | null
          date?: string | null
          discount_percentage?: number | null
          has_partial_return?: boolean | null
          id?: string
          invoice_number: number
          items?: Json
          notes?: string | null
          partial_return_amount?: number | null
          payment_method?: string | null
          representative_code?: string | null
          representative_name?: string | null
          status?: string | null
          time?: string | null
          total_advance_amount?: number
          total_amount?: number
          total_remaining_amount?: number
          updated_at?: string | null
          visa_amount?: number | null
          visa_details?: string | null
        }
        Update: {
          cash_amount?: number | null
          cashier_name?: string | null
          created_at?: string | null
          customer_address?: string | null
          customer_name?: string
          customer_phone?: string | null
          date?: string | null
          discount_percentage?: number | null
          has_partial_return?: boolean | null
          id?: string
          invoice_number?: number
          items?: Json
          notes?: string | null
          partial_return_amount?: number | null
          payment_method?: string | null
          representative_code?: string | null
          representative_name?: string | null
          status?: string | null
          time?: string | null
          total_advance_amount?: number
          total_amount?: number
          total_remaining_amount?: number
          updated_at?: string | null
          visa_amount?: number | null
          visa_details?: string | null
        }
        Relationships: []
      }
      advance_payment_returns: {
        Row: {
          created_at: string
          customer_name: string
          customer_phone: string | null
          date: string | null
          id: string
          is_partial: boolean | null
          items: Json
          original_advance_amount: number
          original_invoice_id: string
          return_amount: number
          return_number: number
          return_reason: string | null
          time: string | null
          total_return_amount: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_name: string
          customer_phone?: string | null
          date?: string | null
          id?: string
          is_partial?: boolean | null
          items?: Json
          original_advance_amount?: number
          original_invoice_id: string
          return_amount?: number
          return_number?: number
          return_reason?: string | null
          time?: string | null
          total_return_amount?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_name?: string
          customer_phone?: string | null
          date?: string | null
          id?: string
          is_partial?: boolean | null
          items?: Json
          original_advance_amount?: number
          original_invoice_id?: string
          return_amount?: number
          return_number?: number
          return_reason?: string | null
          time?: string | null
          total_return_amount?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      app_users: {
        Row: {
          address: string | null
          created_at: string
          email: string
          id: string
          location: Json | null
          name: string
          password: string
          phone: string | null
          role: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          email: string
          id: string
          location?: Json | null
          name: string
          password: string
          phone?: string | null
          role?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          email?: string
          id?: string
          location?: Json | null
          name?: string
          password?: string
          phone?: string | null
          role?: string
        }
        Relationships: []
      }
      attendance: {
        Row: {
          attendance_date: string
          course_id: string
          created_at: string | null
          id: string
          notes: string | null
          parent_phone: string | null
          status: string
          student_id: string
          whatsapp_sent: boolean | null
        }
        Insert: {
          attendance_date: string
          course_id: string
          created_at?: string | null
          id?: string
          notes?: string | null
          parent_phone?: string | null
          status: string
          student_id: string
          whatsapp_sent?: boolean | null
        }
        Update: {
          attendance_date?: string
          course_id?: string
          created_at?: string | null
          id?: string
          notes?: string | null
          parent_phone?: string | null
          status?: string
          student_id?: string
          whatsapp_sent?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "attendance_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_qr_codes: {
        Row: {
          code: string
          created_at: string | null
          expires_at: string
          group_id: string
          id: string
          is_active: boolean | null
          session_date: string
        }
        Insert: {
          code: string
          created_at?: string | null
          expires_at?: string
          group_id: string
          id?: string
          is_active?: boolean | null
          session_date?: string
        }
        Update: {
          code?: string
          created_at?: string | null
          expires_at?: string
          group_id?: string
          id?: string
          is_active?: boolean | null
          session_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_qr_codes_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      broadcast_messages: {
        Row: {
          content: string
          created_at: string | null
          id: string
          sent_at: string | null
          sent_by_admin: boolean | null
          target_audience: Database["public"]["Enums"]["customer_type"] | null
        }
        Insert: {
          content: string
          created_at?: string | null
          id?: string
          sent_at?: string | null
          sent_by_admin?: boolean | null
          target_audience?: Database["public"]["Enums"]["customer_type"] | null
        }
        Update: {
          content?: string
          created_at?: string | null
          id?: string
          sent_at?: string | null
          sent_by_admin?: boolean | null
          target_audience?: Database["public"]["Enums"]["customer_type"] | null
        }
        Relationships: []
      }
      cash_account: {
        Row: {
          amount: number
          category: string | null
          created_at: string
          date: string
          description: string
          id: string
          type: string
          updated_at: string
        }
        Insert: {
          amount: number
          category?: string | null
          created_at?: string
          date: string
          description: string
          id?: string
          type: string
          updated_at?: string
        }
        Update: {
          amount?: number
          category?: string | null
          created_at?: string
          date?: string
          description?: string
          id?: string
          type?: string
          updated_at?: string
        }
        Relationships: []
      }
      course_materials: {
        Row: {
          course_id: string
          created_at: string | null
          description: string | null
          file_name: string | null
          file_path: string
          file_size: number | null
          file_url: string | null
          grade_id: string | null
          id: string
          material_type: string
          title: string
          updated_at: string | null
          uploaded_by: string | null
        }
        Insert: {
          course_id: string
          created_at?: string | null
          description?: string | null
          file_name?: string | null
          file_path: string
          file_size?: number | null
          file_url?: string | null
          grade_id?: string | null
          id?: string
          material_type: string
          title: string
          updated_at?: string | null
          uploaded_by?: string | null
        }
        Update: {
          course_id?: string
          created_at?: string | null
          description?: string | null
          file_name?: string | null
          file_path?: string
          file_size?: number | null
          file_url?: string | null
          grade_id?: string | null
          id?: string
          material_type?: string
          title?: string
          updated_at?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "course_materials_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_materials_grade_id_fkey"
            columns: ["grade_id"]
            isOneToOne: false
            referencedRelation: "grades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_materials_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      courses: {
        Row: {
          created_at: string | null
          description: string | null
          grade_id: string | null
          id: string
          is_active: boolean | null
          name: string
          subject: string | null
          subscription_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          grade_id?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          subject?: string | null
          subscription_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          grade_id?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          subject?: string | null
          subscription_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "courses_grade_id_fkey"
            columns: ["grade_id"]
            isOneToOne: false
            referencedRelation: "grades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "courses_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          assigned_employee_id: string | null
          created_at: string | null
          customer_type: Database["public"]["Enums"]["customer_type"]
          id: string
          name: string
          package_id: string | null
          phone: string
          subscription_end_date: string | null
          subscription_start_date: string | null
          updated_at: string | null
        }
        Insert: {
          assigned_employee_id?: string | null
          created_at?: string | null
          customer_type?: Database["public"]["Enums"]["customer_type"]
          id?: string
          name: string
          package_id?: string | null
          phone: string
          subscription_end_date?: string | null
          subscription_start_date?: string | null
          updated_at?: string | null
        }
        Update: {
          assigned_employee_id?: string | null
          created_at?: string | null
          customer_type?: Database["public"]["Enums"]["customer_type"]
          id?: string
          name?: string
          package_id?: string | null
          phone?: string
          subscription_end_date?: string | null
          subscription_start_date?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_customers_employee"
            columns: ["assigned_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_sessions: {
        Row: {
          created_at: string | null
          employee_id: string | null
          id: string
          login_time: string | null
          logout_time: string | null
          session_duration: number | null
        }
        Insert: {
          created_at?: string | null
          employee_id?: string | null
          id?: string
          login_time?: string | null
          logout_time?: string | null
          session_duration?: number | null
        }
        Update: {
          created_at?: string | null
          employee_id?: string | null
          id?: string
          login_time?: string | null
          logout_time?: string | null
          session_duration?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "employee_sessions_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          bonus_amount: number | null
          created_at: string | null
          customer_type_handling: Database["public"]["Enums"]["employee_customer_type"]
          customers_acquired: number | null
          email: string
          id: string
          is_active: boolean | null
          name: string
          password_hash: string
          phone: string
          target_customers: number | null
          total_session_time: number | null
          updated_at: string | null
        }
        Insert: {
          bonus_amount?: number | null
          created_at?: string | null
          customer_type_handling: Database["public"]["Enums"]["employee_customer_type"]
          customers_acquired?: number | null
          email: string
          id?: string
          is_active?: boolean | null
          name: string
          password_hash: string
          phone: string
          target_customers?: number | null
          total_session_time?: number | null
          updated_at?: string | null
        }
        Update: {
          bonus_amount?: number | null
          created_at?: string | null
          customer_type_handling?: Database["public"]["Enums"]["employee_customer_type"]
          customers_acquired?: number | null
          email?: string
          id?: string
          is_active?: boolean | null
          name?: string
          password_hash?: string
          phone?: string
          target_customers?: number | null
          total_session_time?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      exam_groups: {
        Row: {
          created_at: string | null
          exam_id: string
          group_id: string
          id: string
        }
        Insert: {
          created_at?: string | null
          exam_id: string
          group_id: string
          id?: string
        }
        Update: {
          created_at?: string | null
          exam_id?: string
          group_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "exam_groups_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exam_groups_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_questions: {
        Row: {
          correct_answer: string
          created_at: string | null
          exam_id: string
          explanation: string | null
          id: string
          options: Json | null
          points: number | null
          question_text: string
          question_type: string
        }
        Insert: {
          correct_answer: string
          created_at?: string | null
          exam_id: string
          explanation?: string | null
          id?: string
          options?: Json | null
          points?: number | null
          question_text: string
          question_type?: string
        }
        Update: {
          correct_answer?: string
          created_at?: string | null
          exam_id?: string
          explanation?: string | null
          id?: string
          options?: Json | null
          points?: number | null
          question_text?: string
          question_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "exam_questions_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_results: {
        Row: {
          exam_id: string
          grade: string | null
          id: string
          marks_obtained: number
          remarks: string | null
          student_id: string
          submitted_at: string | null
        }
        Insert: {
          exam_id: string
          grade?: string | null
          id?: string
          marks_obtained: number
          remarks?: string | null
          student_id: string
          submitted_at?: string | null
        }
        Update: {
          exam_id?: string
          grade?: string | null
          id?: string
          marks_obtained?: number
          remarks?: string | null
          student_id?: string
          submitted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "exam_results_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exam_results_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_student_answers: {
        Row: {
          exam_id: string
          id: string
          is_correct: boolean | null
          question_id: string
          student_answer: string
          student_id: string
          submitted_at: string | null
        }
        Insert: {
          exam_id: string
          id?: string
          is_correct?: boolean | null
          question_id: string
          student_answer: string
          student_id: string
          submitted_at?: string | null
        }
        Update: {
          exam_id?: string
          id?: string
          is_correct?: boolean | null
          question_id?: string
          student_answer?: string
          student_id?: string
          submitted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "exam_student_answers_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exam_student_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "exam_questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exam_student_answers_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["id"]
          },
        ]
      }
      exams: {
        Row: {
          course_id: string
          created_at: string | null
          created_by: string | null
          description: string | null
          duration_minutes: number | null
          exam_code: string | null
          exam_date: string | null
          exam_time: string | null
          group_id: string | null
          id: string
          is_active: boolean | null
          questions_count: number | null
          title: string
          total_marks: number | null
          total_questions: number | null
          updated_at: string | null
        }
        Insert: {
          course_id: string
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          duration_minutes?: number | null
          exam_code?: string | null
          exam_date?: string | null
          exam_time?: string | null
          group_id?: string | null
          id?: string
          is_active?: boolean | null
          questions_count?: number | null
          title: string
          total_marks?: number | null
          total_questions?: number | null
          updated_at?: string | null
        }
        Update: {
          course_id?: string
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          duration_minutes?: number | null
          exam_code?: string | null
          exam_date?: string | null
          exam_time?: string | null
          group_id?: string | null
          id?: string
          is_active?: boolean | null
          questions_count?: number | null
          title?: string
          total_marks?: number | null
          total_questions?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "exams_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exams_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "exams_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount: number
          category: string | null
          created_at: string | null
          date: string | null
          description: string
          id: string
          time: string | null
          updated_at: string | null
        }
        Insert: {
          amount: number
          category?: string | null
          created_at?: string | null
          date?: string | null
          description: string
          id?: string
          time?: string | null
          updated_at?: string | null
        }
        Update: {
          amount?: number
          category?: string | null
          created_at?: string | null
          date?: string | null
          description?: string
          id?: string
          time?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      grades: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          is_active: boolean | null
          name: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      group_courses: {
        Row: {
          course_id: string
          created_at: string | null
          group_id: string
          id: string
          schedule_days: string[]
          schedule_times: Json
          updated_at: string | null
        }
        Insert: {
          course_id: string
          created_at?: string | null
          group_id: string
          id?: string
          schedule_days?: string[]
          schedule_times?: Json
          updated_at?: string | null
        }
        Update: {
          course_id?: string
          created_at?: string | null
          group_id?: string
          id?: string
          schedule_days?: string[]
          schedule_times?: Json
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "group_courses_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_courses_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      groups: {
        Row: {
          created_at: string | null
          current_students: number | null
          description: string | null
          grade_id: string | null
          id: string
          is_active: boolean | null
          max_students: number | null
          name: string
          type: Database["public"]["Enums"]["group_type"] | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          current_students?: number | null
          description?: string | null
          grade_id?: string | null
          id?: string
          is_active?: boolean | null
          max_students?: number | null
          name: string
          type?: Database["public"]["Enums"]["group_type"] | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          current_students?: number | null
          description?: string | null
          grade_id?: string | null
          id?: string
          is_active?: boolean | null
          max_students?: number | null
          name?: string
          type?: Database["public"]["Enums"]["group_type"] | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "groups_grade_id_fkey"
            columns: ["grade_id"]
            isOneToOne: false
            referencedRelation: "grades"
            referencedColumns: ["id"]
          },
        ]
      }
      imports: {
        Row: {
          created_at: string
          id: string
          import_date: string
          items: Json
          notes: string | null
          paid_amount: number
          payment_method: string | null
          remaining_amount: number
          supplier_name: string
          supplier_phone: string | null
          total_amount: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          import_date: string
          items?: Json
          notes?: string | null
          paid_amount?: number
          payment_method?: string | null
          remaining_amount?: number
          supplier_name: string
          supplier_phone?: string | null
          total_amount?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          import_date?: string
          items?: Json
          notes?: string | null
          paid_amount?: number
          payment_method?: string | null
          remaining_amount?: number
          supplier_name?: string
          supplier_phone?: string | null
          total_amount?: number
          updated_at?: string
        }
        Relationships: []
      }
      items: {
        Row: {
          code: string
          created_at: string | null
          id: string
          name: string
          updated_at: string | null
        }
        Insert: {
          code: string
          created_at?: string | null
          id?: string
          name: string
          updated_at?: string | null
        }
        Update: {
          code?: string
          created_at?: string | null
          id?: string
          name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      local_data_backup: {
        Row: {
          created_at: string
          data: Json
          id: string
          last_sync: string
          table_name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          data: Json
          id?: string
          last_sync?: string
          table_name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          data?: Json
          id?: string
          last_sync?: string
          table_name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      material_groups: {
        Row: {
          created_at: string | null
          group_id: string
          id: string
          material_id: string
        }
        Insert: {
          created_at?: string | null
          group_id: string
          id?: string
          material_id: string
        }
        Update: {
          created_at?: string | null
          group_id?: string
          id?: string
          material_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "material_groups_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_groups_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "course_materials"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          assigned_employee_id: string | null
          created_at: string | null
          customer_id: string | null
          customer_phone: string
          id: string
          is_from_customer: boolean
          message_content: string
          replied_at: string | null
          replied_by_employee_id: string | null
          reply_content: string | null
          sent_at: string | null
        }
        Insert: {
          assigned_employee_id?: string | null
          created_at?: string | null
          customer_id?: string | null
          customer_phone: string
          id?: string
          is_from_customer: boolean
          message_content: string
          replied_at?: string | null
          replied_by_employee_id?: string | null
          reply_content?: string | null
          sent_at?: string | null
        }
        Update: {
          assigned_employee_id?: string | null
          created_at?: string | null
          customer_id?: string | null
          customer_phone?: string
          id?: string
          is_from_customer?: boolean
          message_content?: string
          replied_at?: string | null
          replied_by_employee_id?: string | null
          reply_content?: string | null
          sent_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_assigned_employee_id_fkey"
            columns: ["assigned_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_replied_by_employee_id_fkey"
            columns: ["replied_by_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      money_operators: {
        Row: {
          amount: number
          created_at: string
          id: string
          investment_date: string
          is_active: boolean
          name: string
          phone: string
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          investment_date: string
          is_active?: boolean
          name: string
          phone: string
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          investment_date?: string
          is_active?: boolean
          name?: string
          phone?: string
          updated_at?: string
        }
        Relationships: []
      }
      online_meetings: {
        Row: {
          created_at: string
          created_by: string | null
          group_id: string
          id: string
          is_active: boolean | null
          meeting_link: string
          meeting_type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          group_id: string
          id?: string
          is_active?: boolean | null
          meeting_link: string
          meeting_type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          group_id?: string
          id?: string
          is_active?: boolean | null
          meeting_link?: string
          meeting_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "online_meetings_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      packages: {
        Row: {
          created_at: string | null
          details: string | null
          duration_days: number
          id: string
          is_active: boolean | null
          name: string
          price: number
          type: Database["public"]["Enums"]["package_type"]
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          details?: string | null
          duration_days: number
          id?: string
          is_active?: boolean | null
          name: string
          price: number
          type: Database["public"]["Enums"]["package_type"]
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          details?: string | null
          duration_days?: number
          id?: string
          is_active?: boolean | null
          name?: string
          price?: number
          type?: Database["public"]["Enums"]["package_type"]
          updated_at?: string | null
        }
        Relationships: []
      }
      products: {
        Row: {
          created_at: string | null
          id: string
          item_code: string
          item_id: string | null
          item_name: string
          max_discount: number | null
          retail_price: number | null
          size_code: string
          size_id: string | null
          size_name: string
          stock: number | null
          unit_price: number | null
          updated_at: string | null
          wholesale_price: number | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          item_code: string
          item_id?: string | null
          item_name: string
          max_discount?: number | null
          retail_price?: number | null
          size_code: string
          size_id?: string | null
          size_name: string
          stock?: number | null
          unit_price?: number | null
          updated_at?: string | null
          wholesale_price?: number | null
        }
        Update: {
          created_at?: string | null
          id?: string
          item_code?: string
          item_id?: string | null
          item_name?: string
          max_discount?: number | null
          retail_price?: number | null
          size_code?: string
          size_id?: string | null
          size_name?: string
          stock?: number | null
          unit_price?: number | null
          updated_at?: string | null
          wholesale_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "products_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_size_id_fkey"
            columns: ["size_id"]
            isOneToOne: false
            referencedRelation: "sizes"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          accessible_pages: Json | null
          address: string | null
          code: string
          created_at: string | null
          email: string | null
          id: string
          is_active: boolean | null
          name: string
          phone: string | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string | null
          user_id: string | null
          username: string
        }
        Insert: {
          accessible_pages?: Json | null
          address?: string | null
          code: string
          created_at?: string | null
          email?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string | null
          user_id?: string | null
          username: string
        }
        Update: {
          accessible_pages?: Json | null
          address?: string | null
          code?: string
          created_at?: string | null
          email?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string | null
          user_id?: string | null
          username?: string
        }
        Relationships: []
      }
      profit_withdrawals: {
        Row: {
          created_at: string
          id: string
          operator_id: string
          operator_name: string
          percentage: number
          profit_amount: number
          updated_at: string
          withdrawal_date: string
        }
        Insert: {
          created_at?: string
          id?: string
          operator_id: string
          operator_name: string
          percentage: number
          profit_amount: number
          updated_at?: string
          withdrawal_date: string
        }
        Update: {
          created_at?: string
          id?: string
          operator_id?: string
          operator_name?: string
          percentage?: number
          profit_amount?: number
          updated_at?: string
          withdrawal_date?: string
        }
        Relationships: []
      }
      profits: {
        Row: {
          amount: number
          created_at: string | null
          date: string | null
          description: string
          id: string
          invoice_id: string | null
          time: string | null
          type: string
          updated_at: string | null
        }
        Insert: {
          amount: number
          created_at?: string | null
          date?: string | null
          description: string
          id?: string
          invoice_id?: string | null
          time?: string | null
          type: string
          updated_at?: string | null
        }
        Update: {
          amount?: number
          created_at?: string | null
          date?: string | null
          description?: string
          id?: string
          invoice_id?: string | null
          time?: string | null
          type?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      reports: {
        Row: {
          created_at: string
          data: Json
          description: string | null
          filters: Json | null
          generated_at: string
          generated_by: string | null
          id: string
          report_type: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          data?: Json
          description?: string | null
          filters?: Json | null
          generated_at?: string
          generated_by?: string | null
          id?: string
          report_type: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          data?: Json
          description?: string | null
          filters?: Json | null
          generated_at?: string
          generated_by?: string | null
          id?: string
          report_type?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      retail_invoices: {
        Row: {
          cash_amount: number | null
          cashier_name: string | null
          commission: number | null
          created_at: string | null
          customer_address: string | null
          customer_name: string
          customer_phone: string | null
          date: string | null
          discount_percentage: number | null
          id: string
          instapay_amount: number | null
          invoice_number: number | null
          items: Json
          payment_method: string | null
          salesman_code: string | null
          salesman_name: string | null
          time: string | null
          total_amount: number
          updated_at: string | null
          visa_amount: number | null
          visa_details: string | null
        }
        Insert: {
          cash_amount?: number | null
          cashier_name?: string | null
          commission?: number | null
          created_at?: string | null
          customer_address?: string | null
          customer_name: string
          customer_phone?: string | null
          date?: string | null
          discount_percentage?: number | null
          id?: string
          instapay_amount?: number | null
          invoice_number?: number | null
          items?: Json
          payment_method?: string | null
          salesman_code?: string | null
          salesman_name?: string | null
          time?: string | null
          total_amount?: number
          updated_at?: string | null
          visa_amount?: number | null
          visa_details?: string | null
        }
        Update: {
          cash_amount?: number | null
          cashier_name?: string | null
          commission?: number | null
          created_at?: string | null
          customer_address?: string | null
          customer_name?: string
          customer_phone?: string | null
          date?: string | null
          discount_percentage?: number | null
          id?: string
          instapay_amount?: number | null
          invoice_number?: number | null
          items?: Json
          payment_method?: string | null
          salesman_code?: string | null
          salesman_name?: string | null
          time?: string | null
          total_amount?: number
          updated_at?: string | null
          visa_amount?: number | null
          visa_details?: string | null
        }
        Relationships: []
      }
      retail_returns: {
        Row: {
          created_at: string
          customer_address: string | null
          customer_name: string
          customer_phone: string | null
          date: string | null
          id: string
          invoice_id: string | null
          items: Json
          reason: string | null
          return_amount: number | null
          return_number: number | null
          time: string | null
          total_return_amount: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_address?: string | null
          customer_name: string
          customer_phone?: string | null
          date?: string | null
          id?: string
          invoice_id?: string | null
          items?: Json
          reason?: string | null
          return_amount?: number | null
          return_number?: number | null
          time?: string | null
          total_return_amount?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_address?: string | null
          customer_name?: string
          customer_phone?: string | null
          date?: string | null
          id?: string
          invoice_id?: string | null
          items?: Json
          reason?: string | null
          return_amount?: number | null
          return_number?: number | null
          time?: string | null
          total_return_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "retail_returns_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "retail_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      salesmen: {
        Row: {
          address: string | null
          code: string | null
          created_at: string | null
          fixed_salary: number | null
          id: string
          is_active: boolean | null
          name: string
          phone: string | null
          sales_percentage: number | null
          total_earned: number | null
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          code?: string | null
          created_at?: string | null
          fixed_salary?: number | null
          id?: string
          is_active?: boolean | null
          name: string
          phone?: string | null
          sales_percentage?: number | null
          total_earned?: number | null
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          code?: string | null
          created_at?: string | null
          fixed_salary?: number | null
          id?: string
          is_active?: boolean | null
          name?: string
          phone?: string | null
          sales_percentage?: number | null
          total_earned?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      sizes: {
        Row: {
          code: string
          created_at: string | null
          id: string
          name: string
          updated_at: string | null
        }
        Insert: {
          code: string
          created_at?: string | null
          id?: string
          name: string
          updated_at?: string | null
        }
        Update: {
          code?: string
          created_at?: string | null
          id?: string
          name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      staff: {
        Row: {
          accessible_pages: Json | null
          created_at: string | null
          email: string
          id: string
          is_active: boolean | null
          name: string
          password: string
          phone: string | null
          role: string
          updated_at: string | null
        }
        Insert: {
          accessible_pages?: Json | null
          created_at?: string | null
          email: string
          id?: string
          is_active?: boolean | null
          name: string
          password: string
          phone?: string | null
          role?: string
          updated_at?: string | null
        }
        Update: {
          accessible_pages?: Json | null
          created_at?: string | null
          email?: string
          id?: string
          is_active?: boolean | null
          name?: string
          password?: string
          phone?: string | null
          role?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      student_courses: {
        Row: {
          course_id: string
          enrolled_at: string | null
          id: string
          is_active: boolean | null
          student_id: string
        }
        Insert: {
          course_id: string
          enrolled_at?: string | null
          id?: string
          is_active?: boolean | null
          student_id: string
        }
        Update: {
          course_id?: string
          enrolled_at?: string | null
          id?: string
          is_active?: boolean | null
          student_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "student_courses_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_courses_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["id"]
          },
        ]
      }
      student_fees: {
        Row: {
          amount: number
          created_at: string | null
          description: string | null
          due_date: string
          id: string
          paid_date: string | null
          status: string
          student_id: string
          updated_at: string | null
        }
        Insert: {
          amount: number
          created_at?: string | null
          description?: string | null
          due_date: string
          id?: string
          paid_date?: string | null
          status?: string
          student_id: string
          updated_at?: string | null
        }
        Update: {
          amount?: number
          created_at?: string | null
          description?: string | null
          due_date?: string
          id?: string
          paid_date?: string | null
          status?: string
          student_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "student_fees_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["id"]
          },
        ]
      }
      student_registration_requests: {
        Row: {
          created_at: string | null
          email: string
          grade_id: string | null
          group_id: string | null
          id: string
          name: string
          password_hash: string
          phone: string
          rejection_reason: string | null
          requested_courses: string[] | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          email: string
          grade_id?: string | null
          group_id?: string | null
          id?: string
          name: string
          password_hash: string
          phone: string
          rejection_reason?: string | null
          requested_courses?: string[] | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          email?: string
          grade_id?: string | null
          group_id?: string | null
          id?: string
          name?: string
          password_hash?: string
          phone?: string
          rejection_reason?: string | null
          requested_courses?: string[] | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "student_registration_requests_grade_id_fkey"
            columns: ["grade_id"]
            isOneToOne: false
            referencedRelation: "grades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_registration_requests_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      students: {
        Row: {
          approval_status: string | null
          approved_at: string | null
          approved_by: string | null
          barcode_id: string | null
          created_at: string | null
          email: string
          enrollment_date: string | null
          grade: string | null
          grade_id: string | null
          group_id: string | null
          id: string
          is_active: boolean | null
          is_offline: boolean | null
          name: string
          password: string | null
          password_hash: string | null
          phone: string | null
          registration_form_url: string | null
          study_type: string | null
          subscription_end_date: string | null
          subscription_id: string | null
          subscription_price: number | null
          subscription_start_date: string | null
          temporary_password: string | null
          updated_at: string | null
        }
        Insert: {
          approval_status?: string | null
          approved_at?: string | null
          approved_by?: string | null
          barcode_id?: string | null
          created_at?: string | null
          email: string
          enrollment_date?: string | null
          grade?: string | null
          grade_id?: string | null
          group_id?: string | null
          id?: string
          is_active?: boolean | null
          is_offline?: boolean | null
          name: string
          password?: string | null
          password_hash?: string | null
          phone?: string | null
          registration_form_url?: string | null
          study_type?: string | null
          subscription_end_date?: string | null
          subscription_id?: string | null
          subscription_price?: number | null
          subscription_start_date?: string | null
          temporary_password?: string | null
          updated_at?: string | null
        }
        Update: {
          approval_status?: string | null
          approved_at?: string | null
          approved_by?: string | null
          barcode_id?: string | null
          created_at?: string | null
          email?: string
          enrollment_date?: string | null
          grade?: string | null
          grade_id?: string | null
          group_id?: string | null
          id?: string
          is_active?: boolean | null
          is_offline?: boolean | null
          name?: string
          password?: string | null
          password_hash?: string | null
          phone?: string | null
          registration_form_url?: string | null
          study_type?: string | null
          subscription_end_date?: string | null
          subscription_id?: string | null
          subscription_price?: number | null
          subscription_start_date?: string | null
          temporary_password?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "students_grade_id_fkey"
            columns: ["grade_id"]
            isOneToOne: false
            referencedRelation: "grades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "students_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "students_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          created_at: string | null
          description: string | null
          duration_months: number
          id: string
          is_active: boolean | null
          name: string
          price: number
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          duration_months: number
          id?: string
          is_active?: boolean | null
          name: string
          price?: number
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          duration_months?: number
          id?: string
          is_active?: boolean | null
          name?: string
          price?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      supplier_invoices: {
        Row: {
          cashier_name: string | null
          created_at: string | null
          date: string | null
          id: string
          invoice_number: number
          items: Json
          paid_amount: number
          remaining_amount: number
          supplier_address: string | null
          supplier_id: string | null
          supplier_name: string
          supplier_phone: string | null
          time: string | null
          total_amount: number
          updated_at: string | null
        }
        Insert: {
          cashier_name?: string | null
          created_at?: string | null
          date?: string | null
          id?: string
          invoice_number: number
          items?: Json
          paid_amount?: number
          remaining_amount?: number
          supplier_address?: string | null
          supplier_id?: string | null
          supplier_name: string
          supplier_phone?: string | null
          time?: string | null
          total_amount?: number
          updated_at?: string | null
        }
        Update: {
          cashier_name?: string | null
          created_at?: string | null
          date?: string | null
          id?: string
          invoice_number?: number
          items?: Json
          paid_amount?: number
          remaining_amount?: number
          supplier_address?: string | null
          supplier_id?: string | null
          supplier_name?: string
          supplier_phone?: string | null
          time?: string | null
          total_amount?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "supplier_invoices_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_returns: {
        Row: {
          created_at: string | null
          date: string | null
          id: string
          items: Json
          reason: string | null
          related_invoice_id: string | null
          return_number: number
          supplier_address: string | null
          supplier_id: string | null
          supplier_name: string
          supplier_phone: string | null
          time: string | null
          total_return_amount: number
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          date?: string | null
          id?: string
          items?: Json
          reason?: string | null
          related_invoice_id?: string | null
          return_number?: number
          supplier_address?: string | null
          supplier_id?: string | null
          supplier_name: string
          supplier_phone?: string | null
          time?: string | null
          total_return_amount?: number
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          date?: string | null
          id?: string
          items?: Json
          reason?: string | null
          related_invoice_id?: string | null
          return_number?: number
          supplier_address?: string | null
          supplier_id?: string | null
          supplier_name?: string
          supplier_phone?: string | null
          time?: string | null
          total_return_amount?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "supplier_returns_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          address: string | null
          created_at: string | null
          email: string | null
          id: string
          name: string
          notes: string | null
          phone: string | null
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      teacher_messages: {
        Row: {
          id: string
          is_read: boolean | null
          message_text: string
          recipient_id: string | null
          sender_id: string | null
          sent_at: string | null
          student_id: string | null
        }
        Insert: {
          id?: string
          is_read?: boolean | null
          message_text: string
          recipient_id?: string | null
          sender_id?: string | null
          sent_at?: string | null
          student_id?: string | null
        }
        Update: {
          id?: string
          is_read?: boolean | null
          message_text?: string
          recipient_id?: string | null
          sender_id?: string | null
          sent_at?: string | null
          student_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "teacher_messages_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "teacher_messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teacher_messages_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string | null
          id: string
          role: Database["public"]["Enums"]["user_role"]
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          role: Database["public"]["Enums"]["user_role"]
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          role?: Database["public"]["Enums"]["user_role"]
          user_id?: string
        }
        Relationships: []
      }
      users: {
        Row: {
          address: string | null
          created_at: string | null
          email: string
          full_name: string
          id: string
          location: Json | null
          phone: string | null
          role: string
        }
        Insert: {
          address?: string | null
          created_at?: string | null
          email: string
          full_name: string
          id?: string
          location?: Json | null
          phone?: string | null
          role?: string
        }
        Update: {
          address?: string | null
          created_at?: string | null
          email?: string
          full_name?: string
          id?: string
          location?: Json | null
          phone?: string | null
          role?: string
        }
        Relationships: []
      }
      wholesale_invoices: {
        Row: {
          cash_amount: number | null
          cashier_name: string | null
          created_at: string | null
          customer_address: string | null
          customer_name: string
          customer_phone: string | null
          date: string | null
          discount_percentage: number | null
          id: string
          instapay_amount: number | null
          invoice_number: number | null
          items: Json
          payment_method: string | null
          representative_code: string | null
          representative_name: string | null
          time: string | null
          total_amount: number
          updated_at: string | null
          visa_amount: number | null
          visa_details: string | null
        }
        Insert: {
          cash_amount?: number | null
          cashier_name?: string | null
          created_at?: string | null
          customer_address?: string | null
          customer_name: string
          customer_phone?: string | null
          date?: string | null
          discount_percentage?: number | null
          id?: string
          instapay_amount?: number | null
          invoice_number?: number | null
          items?: Json
          payment_method?: string | null
          representative_code?: string | null
          representative_name?: string | null
          time?: string | null
          total_amount?: number
          updated_at?: string | null
          visa_amount?: number | null
          visa_details?: string | null
        }
        Update: {
          cash_amount?: number | null
          cashier_name?: string | null
          created_at?: string | null
          customer_address?: string | null
          customer_name?: string
          customer_phone?: string | null
          date?: string | null
          discount_percentage?: number | null
          id?: string
          instapay_amount?: number | null
          invoice_number?: number | null
          items?: Json
          payment_method?: string | null
          representative_code?: string | null
          representative_name?: string | null
          time?: string | null
          total_amount?: number
          updated_at?: string | null
          visa_amount?: number | null
          visa_details?: string | null
        }
        Relationships: []
      }
      wholesale_returns: {
        Row: {
          created_at: string
          customer_address: string | null
          customer_name: string
          customer_phone: string | null
          date: string | null
          id: string
          invoice_id: string | null
          items: Json
          reason: string | null
          return_amount: number | null
          return_number: number | null
          time: string | null
          total_return_amount: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_address?: string | null
          customer_name: string
          customer_phone?: string | null
          date?: string | null
          id?: string
          invoice_id?: string | null
          items?: Json
          reason?: string | null
          return_amount?: number | null
          return_number?: number | null
          time?: string | null
          total_return_amount?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_address?: string | null
          customer_name?: string
          customer_phone?: string | null
          date?: string | null
          id?: string
          invoice_id?: string | null
          items?: Json
          reason?: string | null
          return_amount?: number | null
          return_number?: number | null
          time?: string | null
          total_return_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "wholesale_returns_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "wholesale_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      calculate_and_store_profits: { Args: never; Returns: undefined }
      get_current_user_role: { Args: never; Returns: string }
      get_next_advance_payment_invoice_number: { Args: never; Returns: number }
      get_next_advance_payment_return_number: { Args: never; Returns: number }
      get_next_retail_invoice_number: { Args: never; Returns: number }
      get_next_retail_return_number: { Args: never; Returns: number }
      get_next_supplier_return_number: { Args: never; Returns: number }
      get_next_wholesale_invoice_number: { Args: never; Returns: number }
      get_next_wholesale_return_number: { Args: never; Returns: number }
      get_product_sales_report: {
        Args: { p_item_code: string; p_size_code: string }
        Returns: {
          current_stock: number
          net_sold: number
          total_returned: number
          total_sold: number
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["user_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_admin:
        | { Args: { _user_id: string }; Returns: boolean }
        | { Args: never; Returns: boolean }
      is_student: { Args: { _user_id: string }; Returns: boolean }
      make_user_admin: { Args: { admin_email: string }; Returns: undefined }
      search_retail_invoices: {
        Args: { search_term: string }
        Returns: {
          customer_name: string
          customer_phone: string
          date: string
          id: string
          invoice_number: number
          items: Json
          total_amount: number
        }[]
      }
    }
    Enums: {
      customer_type: "new" | "current" | "returning"
      employee_customer_type: "new" | "current_and_returning"
      group_type: "offline" | "online"
      package_type: "basic" | "premium" | "enterprise"
      user_role: "admin" | "representative" | "salesman" | "student"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      customer_type: ["new", "current", "returning"],
      employee_customer_type: ["new", "current_and_returning"],
      group_type: ["offline", "online"],
      package_type: ["basic", "premium", "enterprise"],
      user_role: ["admin", "representative", "salesman", "student"],
    },
  },
} as const
