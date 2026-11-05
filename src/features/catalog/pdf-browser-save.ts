/** Transient object URLs only, cleaned on timeout, identity change and disposal. */
export function createPdfBrowserSaver() {
  const urls = new Map<string, ReturnType<typeof setTimeout>>();
  const clear = () => { for (const [url,timer] of urls) { clearTimeout(timer); URL.revokeObjectURL(url); } urls.clear(); };
  return {
    save(blob: Blob, contentId: string) {
      if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(contentId) || blob.type !== 'application/pdf' || blob.size < 5 || blob.size > 10*1024*1024) throw Error('Invalid PDF download');
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      try {
        anchor.href=url; anchor.download=`lesson-material-${contentId.toLowerCase()}.pdf`; document.body.appendChild(anchor); anchor.click();
        urls.set(url,setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); },1000));
      } catch(error) { URL.revokeObjectURL(url); throw error; }
      finally { anchor.remove(); }
    }, clear,
  };
}
