import {Component,type ReactNode} from 'react';
import {useLocation} from 'react-router-dom';

class PageFailure extends Component<{children:ReactNode},{failed:boolean}>{
  state={failed:false};
  static getDerivedStateFromError(){return{failed:true};}
  render(){return this.state.failed?<main dir="rtl" role="alert" className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
    <p>تعذر تحميل الصفحة. تحقق من الاتصال ثم أعد تحميلها.</p>
    <button type="button" className="rounded border px-4 py-2" onClick={()=>window.location.reload()}>إعادة تحميل الصفحة</button>
  </main>:this.props.children;}
}
/** Reset only on route navigation; never automatically reload or retry a write. */
export function RouteBoundary({children}:{children:ReactNode}){const location=useLocation();return <PageFailure key={location.pathname}>{children}</PageFailure>;}
