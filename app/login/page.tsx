export const dynamic = "force-dynamic";

export default function LoginPage({ searchParams }: { searchParams?: { error?: string; next?: string } }) {
  const next = typeof searchParams?.next === "string" && searchParams.next.startsWith("/") ? searchParams.next : "/live";
  return (
    <main style={{minHeight:"100vh",display:"grid",placeItems:"center",background:"#04140d",color:"#effff6",fontFamily:"Arial,sans-serif",padding:24}}>
      <form action="/api/auth/login" method="post" style={{width:"100%",maxWidth:420,background:"#0a2117",border:"1px solid #285c43",borderRadius:24,padding:28}}>
        <div style={{fontSize:12,letterSpacing:".16em",color:"#72c49c"}}>PRIVATE OWNER ACCESS</div>
        <h1 style={{fontSize:36,margin:"12px 0"}}>Sign in once</h1>
        <p style={{color:"#a4baaf",lineHeight:1.5}}>Enter your dashboard password. You will stay signed in on this browser for 12 hours.</p>
        {searchParams?.error && <p style={{background:"#3a1515",color:"#ffcaca",padding:12,borderRadius:12}}>Incorrect password.</p>}
        <input type="hidden" name="next" value={next}/>
        <label style={{display:"block",marginTop:18,marginBottom:8}}>Password</label>
        <input name="password" type="password" autoComplete="current-password" required style={{width:"100%",boxSizing:"border-box",padding:15,borderRadius:12,border:"1px solid #35694e",background:"#06150f",color:"#fff",fontSize:18}}/>
        <button type="submit" style={{width:"100%",marginTop:18,padding:16,border:0,borderRadius:14,background:"#1d995f",color:"#fff",fontWeight:800,fontSize:17}}>SIGN IN</button>
      </form>
    </main>
  );
}
