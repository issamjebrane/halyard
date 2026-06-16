//+------------------------------------------------------------------+
//|  HalyardCopier.mq5  v2.2 — RATCHET + heartbeat + daily guard     |
//|  Copies Gold VIP signals from Supabase and manages them with the |
//|  validated RATCHET exit (trailing stop by levels). No Python/IPC.|
//|                                                                  |
//|  RATCHET (docs/ESTRATEGIA_SIMON_INGENIERO.md §1):               |
//|    open at market, SL = signal SL, target = TP3                  |
//|    price hits TP1 -> move SL to ENTRY (break-even)               |
//|    price hits TP2 -> move SL to TP1                              |
//|    price hits TP3 -> close 100% (handled by the order's TP)      |
//|    live SL hit    -> close. MAX_HOLD -> close at market.         |
//|  v2.2: posts a heartbeat (status + broker price + equity) each   |
//|        poll, and a daily-loss / max-trades-per-day kill switch.  |
//+------------------------------------------------------------------+
#property strict
#property version   "2.40"
#property description "Halyard -> MT5 copier: RATCHET, heartbeat, daily kill-switch, close reporting, multi-instance (telegram / simon)."

#include <Trade/Trade.mqh>

input string InpSupabaseUrl     = "https://gswxrgoeiqszaawzltwm.supabase.co";
input string InpServiceKey      = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdzd3hyZ29laXFzemFhd3psdHdtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDU5NjU2NCwiZXhwIjoyMDk2MTcyNTY0fQ.1mmZMTN2KdkJNRKGuVQniYCPiYblU0iJqmpBgRVBMdw";
input string InpSource          = "telegram:gold_vip"; // signal source; "manual"/"simon"/"" = manual signals (source IS NULL)
input int    InpStatusId        = 1;         // heartbeat slot in mt5_status (1 = telegram engine, 2 = simon engine, ...)
input string InpLabel           = "gold vip";// label shown for this engine on the dashboard
input string InpSymbol          = "XAUUSD";  // broker's gold symbol; empty = chart symbol
input double InpRiskPct         = 3.0;       // % equity risked at the ORIGINAL stop (doc: 2% start, 4-5% optimum)
input double InpMaxExposurePct  = 15.0;      // cap on total concurrent risk across open positions (doc §9.4)
input double InpMaxDailyLossPct = 8.0;       // halt new entries if today's realized loss >= this % of balance (0 = off)
input int    InpMaxTradesPerDay = 0;         // halt new entries after this many entries today (0 = off)
input double InpMinStopDist     = 2.5;       // skip signals with stop tighter than this ($) — noise (doc #20)
input double InpMaxSlippage     = 3.0;       // skip if |current price - signal entry| exceeds this
input int    InpMaxHoldHours    = 72;        // close at market if neither TP3 nor SL hit in this time
input int    InpMaxOpen         = 6;
input int    InpMagic           = 778899;
input int    InpPollSeconds     = 5;
input bool   InpDryRun          = false;     // true = log only, place/modify nothing (heartbeat still posts)

CTrade trade;
long   g_startMaxId = -1;
string g_sym;
string g_status = "starting";

// per-signal level cache (so RATCHET survives an EA reload). entry = ACTUAL fill.
long   c_sid[];
double c_entry[], c_sl[], c_tp1[], c_tp2[], c_tp3[];
// in-memory "already acted on this signal this session" set (double-open guard).
long   g_acted[];
// positions (our magic) seen OPEN on the previous tick, so a close can be detected
// and its realized outcome reported back to the executions ledger. parallel arrays.
long   g_openPos[];   // POSITION_IDENTIFIER
long   g_openSid[];   // signal id (from the "hal<id>" comment)

//------------------------------------------------------------------ utils
string Trim(string s){ StringReplace(s,"\r",""); StringTrimLeft(s); StringTrimRight(s); return s; }
string Enc(string s){ StringReplace(s,":","%3A"); return s; }

bool Acted(long id){ for(int i=0;i<ArraySize(g_acted);i++) if(g_acted[i]==id) return true; return false; }
void MarkActed(long id){ if(Acted(id)) return; int n=ArraySize(g_acted); ArrayResize(g_acted,n+1); g_acted[n]=id; }

bool HttpGet(string url, string &out)
{
   char data[]; char res[]; string rh;
   string h="apikey: "+InpServiceKey+"\r\nAuthorization: Bearer "+InpServiceKey+"\r\nAccept: text/csv\r\n";
   ResetLastError();
   int code=WebRequest("GET",url,h,10000,data,res,rh);
   if(code==-1){ Print("GET failed err=",GetLastError()," (4014 => whitelist ",InpSupabaseUrl,")"); return false; }
   out=CharArrayToString(res,0,WHOLE_ARRAY,CP_UTF8);
   if(code<200 || code>=300){ Print("GET http ",code,": ",out); return false; }
   return true;
}

// Generalized POST/PATCH. `prefer` lets callers request upsert (merge-duplicates).
bool HttpSend(string method, string url, string body, string prefer="return=minimal")
{
   char data[]; int len=StringToCharArray(body,data,0,StringLen(body),CP_UTF8);
   if(len>0 && data[len-1]==0) ArrayResize(data,len-1);
   char res[]; string rh;
   string h="apikey: "+InpServiceKey+"\r\nAuthorization: Bearer "+InpServiceKey+
            "\r\nContent-Type: application/json\r\nPrefer: "+prefer+"\r\n";
   ResetLastError();
   int code=WebRequest(method,url,h,10000,data,res,rh);
   if(code==-1){ Print(method," failed err=",GetLastError()); return false; }
   if(code<200 || code>=300){ Print(method," http ",code,": ",CharArrayToString(res,0,WHOLE_ARRAY,CP_UTF8)); return false; }
   return true;
}
bool HttpPostJson(string url, string body){ return HttpSend("POST",url,body); }

long FetchMaxId()
{
   string s;
   if(!HttpGet(InpSupabaseUrl+"/rest/v1/signals?select=id&order=id.desc&limit=1",s)) return -1;
   string lines[]; int n=StringSplit(s,'\n',lines);
   for(int i=1;i<n;i++){ string t=Trim(lines[i]); if(StringLen(t)>0) return (long)StringToInteger(t); }
   return 0;
}

bool IsDone(string csv, long id)
{
   string lines[]; int n=StringSplit(csv,'\n',lines);
   for(int i=1;i<n;i++){ if((long)StringToInteger(Trim(lines[i]))==id) return true; }
   return false;
}

int CountMine()
{
   int c=0;
   for(int i=PositionsTotal()-1;i>=0;i--){
      ulong t=PositionGetTicket(i);
      if(PositionSelectByTicket(t) && PositionGetInteger(POSITION_MAGIC)==InpMagic) c++;
   }
   return c;
}

// Today's realized P&L (% of balance, positive = loss) and number of entries, for our magic.
void DailyStats(double &lossPct, int &tradesIn)
{
   lossPct=0; tradesIn=0;
   datetime sod=(datetime)(TimeGMT() - (TimeGMT() % 86400));
   if(!HistorySelect(sod, TimeGMT()+60)) return;
   double pnl=0; int total=HistoryDealsTotal();
   for(int i=0;i<total;i++){
      ulong t=HistoryDealGetTicket(i);
      if(t==0 || HistoryDealGetInteger(t,DEAL_MAGIC)!=InpMagic) continue;
      pnl += HistoryDealGetDouble(t,DEAL_PROFIT)+HistoryDealGetDouble(t,DEAL_SWAP)+HistoryDealGetDouble(t,DEAL_COMMISSION);
      if(HistoryDealGetInteger(t,DEAL_ENTRY)==DEAL_ENTRY_IN) tradesIn++;
   }
   double bal=AccountInfoDouble(ACCOUNT_BALANCE);
   if(bal>0 && pnl<0) lossPct = -pnl/bal*100.0;
}

double CalcLots(double entry, double sl)
{
   double tv=SymbolInfoDouble(g_sym,SYMBOL_TRADE_TICK_VALUE);
   double ts=SymbolInfoDouble(g_sym,SYMBOL_TRADE_TICK_SIZE);
   double dist=MathAbs(entry-sl);
   if(dist<=0 || ts<=0 || tv<=0) return 0;
   double lossPerLot=(dist/ts)*tv;
   if(lossPerLot<=0) return 0;
   double risk=AccountInfoDouble(ACCOUNT_EQUITY)*(InpRiskPct/100.0);
   double vmin=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_MIN);
   double vmax=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_MAX);
   double vstep=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_STEP);
   double lots=risk/lossPerLot;
   if(vstep>0) lots=MathFloor(lots/vstep)*vstep;
   if(lots<vmin){
      if(vmin*lossPerLot > risk*1.10){
         Print("sizing: min lot ",vmin," would risk ",DoubleToString(vmin*lossPerLot,2),
               " > budget ",DoubleToString(risk,2)," -> skip (balance too small for ",InpRiskPct,"%)");
         return 0;
      }
      lots=vmin;
   }
   if(lots>vmax) lots=vmax;
   return lots;
}

//------------------------------------------------------------------ level cache
void CachePut(long sid,double e,double sl,double t1,double t2,double t3)
{
   for(int i=0;i<ArraySize(c_sid);i++) if(c_sid[i]==sid){ c_entry[i]=e; return; }
   int n=ArraySize(c_sid);
   ArrayResize(c_sid,n+1); ArrayResize(c_entry,n+1); ArrayResize(c_sl,n+1);
   ArrayResize(c_tp1,n+1); ArrayResize(c_tp2,n+1); ArrayResize(c_tp3,n+1);
   c_sid[n]=sid; c_entry[n]=e; c_sl[n]=sl; c_tp1[n]=t1; c_tp2[n]=t2; c_tp3[n]=t3;
}

bool GetLevels(long sid,double &e,double &sl,double &t1,double &t2,double &t3)
{
   for(int i=0;i<ArraySize(c_sid);i++)
      if(c_sid[i]==sid){ e=c_entry[i];sl=c_sl[i];t1=c_tp1[i];t2=c_tp2[i];t3=c_tp3[i]; return true; }
   string s;
   if(!HttpGet(InpSupabaseUrl+"/rest/v1/signals?id=eq."+(string)sid+"&select=entry_price,stop_loss,tp1,tp2,tp3",s)) return false;
   string lines[]; int n=StringSplit(s,'\n',lines);
   if(n<2) return false;
   string f[]; int m=StringSplit(Trim(lines[1]),',',f);
   if(m<2) return false;
   e=StringToDouble(Trim(f[0])); sl=StringToDouble(Trim(f[1]));
   t1=(m>2 && StringLen(Trim(f[2]))>0)?StringToDouble(Trim(f[2])):0;
   t2=(m>3 && StringLen(Trim(f[3]))>0)?StringToDouble(Trim(f[3])):0;
   t3=(m>4 && StringLen(Trim(f[4]))>0)?StringToDouble(Trim(f[4])):0;
   CachePut(sid,e,sl,t1,t2,t3);
   return true;
}

long SidFromComment(string cm){ if(StringFind(cm,"hal")==0){ long v=(long)StringToInteger(StringSubstr(cm,3)); if(v>0) return v; } return -1; }

void Mark(long id, string status, string detail)
{
   if(InpDryRun) return;
   HttpPostJson(InpSupabaseUrl+"/rest/v1/executions",
     "{\"signal_id\":"+(string)id+",\"status\":\""+status+"\",\"detail\":\""+detail+"\"}");
}

bool LevelsValid(string dir,double entry,double sl,double tp1,double tp2,double tp3)
{
   if(tp1<=0 || sl<=0 || entry<=0) return false;
   if(dir=="buy")  return (sl < entry && entry < tp1 && (tp2<=0 || tp2>tp1) && (tp3<=0 || tp3>tp2));
   if(dir=="sell") return (tp1 < entry && entry < sl && (tp2<=0 || tp2<tp1) && (tp3<=0 || tp3<tp2));
   return false;
}

//------------------------------------------------------------------ open a new signal (RATCHET entry)
void TryPlace(long id, string dir, double entry, double sl, double tp1, double tp2, double tp3)
{
   if(!InpDryRun) MarkActed(id);   // live session guard: act once even if the DB write later fails

   // daily kill-switch
   if(InpMaxDailyLossPct>0 || InpMaxTradesPerDay>0){
      double lp; int td; DailyStats(lp,td);
      if(InpMaxDailyLossPct>0 && lp>=InpMaxDailyLossPct){
         Print("#",id," skip: daily loss cap (",DoubleToString(lp,1),"% >= ",InpMaxDailyLossPct,"%)"); Mark(id,"skipped","daily loss cap"); return; }
      if(InpMaxTradesPerDay>0 && td>=InpMaxTradesPerDay){
         Print("#",id," skip: daily trade cap (",td,"/",InpMaxTradesPerDay,")"); Mark(id,"skipped","daily trade cap"); return; }
   }

   int maxopen=InpMaxOpen;
   if((ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE)==ACCOUNT_MARGIN_MODE_RETAIL_NETTING) maxopen=1;
   if(CountMine()>=maxopen){ Print("#",id," skip: max open (",maxopen,")"); Mark(id,"skipped","max open"); return; }

   if((CountMine()+1)*InpRiskPct > InpMaxExposurePct){
      Print("#",id," skip: exposure cap (",InpMaxExposurePct,"%) reached"); Mark(id,"skipped","exposure cap"); return; }

   if(!LevelsValid(dir,entry,sl,tp1,tp2,tp3)){ Print("#",id," skip: invalid levels"); Mark(id,"skipped","invalid levels"); return; }

   double stopDist=MathAbs(entry-sl);
   if(stopDist < InpMinStopDist){ Print("#",id," skip: stop too tight (",stopDist,"$)"); Mark(id,"skipped","stop too tight"); return; }

   double cur=(dir=="buy"?SymbolInfoDouble(g_sym,SYMBOL_ASK):SymbolInfoDouble(g_sym,SYMBOL_BID));
   if(MathAbs(cur-entry)>InpMaxSlippage){ Print("#",id," skip: price ",cur," far from entry ",entry); Mark(id,"skipped","slippage"); return; }

   double lots=CalcLots(entry,sl);
   if(lots<=0){ Print("#",id," skip: sizing failed/over-risk"); Mark(id,"skipped","sizing"); return; }

   double target = (tp3>0 ? tp3 : (tp2>0 ? tp2 : tp1));   // RATCHET closes at highest provided TP

   PrintFormat("#%d %s %s @~%.2f SL %.2f -> TP3 %.2f (TP1 %.2f TP2 %.2f) %.2f lots %s",
               id,dir,g_sym,cur,sl,target,tp1,tp2,lots,(InpDryRun?"[DRY_RUN]":""));
   if(InpDryRun) return;

   bool ok=(dir=="buy") ? trade.Buy(lots,g_sym,0.0,sl,target,"hal"+(string)id)
                        : trade.Sell(lots,g_sym,0.0,sl,target,"hal"+(string)id);
   if(!ok){ Print("#",id," ORDER FAILED: ",trade.ResultRetcode()," ",trade.ResultRetcodeDescription());
            Mark(id,"error","retcode "+(string)trade.ResultRetcode()); return; }

   ulong ticket=trade.ResultOrder();
   double fill=trade.ResultPrice();
   CachePut(id,fill,sl,tp1,tp2,tp3);
   Print("#",id," PLACED ticket=",ticket," fill=",fill," lots=",lots," (RATCHET, target ",target,")");
   HttpPostJson(InpSupabaseUrl+"/rest/v1/executions",
     "{\"signal_id\":"+(string)id+",\"account\":\""+(string)AccountInfoInteger(ACCOUNT_LOGIN)+
     "\",\"status\":\"placed\",\"tickets\":["+(string)ticket+"],\"lots\":"+DoubleToString(lots,2)+
     ",\"entry_fill\":"+DoubleToString(fill,2)+"}");
}

//------------------------------------------------------------------ RATCHET management
void ManageRatchet()
{
   double pt=SymbolInfoDouble(g_sym,SYMBOL_POINT);
   for(int i=PositionsTotal()-1;i>=0;i--){
      ulong ticket=PositionGetTicket(i);
      if(!PositionSelectByTicket(ticket)) continue;
      if(PositionGetInteger(POSITION_MAGIC)!=InpMagic) continue;
      if(PositionGetString(POSITION_SYMBOL)!=g_sym) continue;

      long sid=SidFromComment(PositionGetString(POSITION_COMMENT));
      bool isBuy=(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY);
      double curSL=PositionGetDouble(POSITION_SL);
      double curTP=PositionGetDouble(POSITION_TP);
      datetime ot=(datetime)PositionGetInteger(POSITION_TIME);

      if(InpMaxHoldHours>0 && (TimeCurrent()-ot) > (long)InpMaxHoldHours*3600){
         Print("#",sid," MAX_HOLD reached -> closing at market");
         if(!InpDryRun && !trade.PositionClose(ticket)) Print("#",sid," MAX_HOLD close FAILED: ",trade.ResultRetcodeDescription());
         continue;
      }

      double e,sl,t1,t2,t3;
      if(sid<0 || !GetLevels(sid,e,sl,t1,t2,t3)) continue;

      double favHi=e, favLo=e, hi[], lo[];
      int nh=CopyHigh(g_sym,PERIOD_M1,ot,TimeCurrent(),hi);
      int nl=CopyLow (g_sym,PERIOD_M1,ot,TimeCurrent(),lo);
      if(nh>0) favHi=hi[ArrayMaximum(hi)];
      if(nl>0) favLo=lo[ArrayMinimum(lo)];
      favHi=MathMax(favHi,SymbolInfoDouble(g_sym,SYMBOL_BID));
      favLo=MathMin(favLo,SymbolInfoDouble(g_sym,SYMBOL_ASK));

      bool hitTP1 = isBuy ? (favHi>=t1) : (favLo<=t1);
      bool hitTP2 = (t2>0) && (isBuy ? (favHi>=t2) : (favLo<=t2));

      double want = sl;
      if(hitTP2)      want = t1;
      else if(hitTP1) want = e;

      bool improve = isBuy ? (want > curSL + pt) : (want < curSL - pt);
      if(improve){
         Print("#",sid," RATCHET: move SL ",curSL," -> ",want, hitTP2?" (after TP2)":" (after TP1)");
         if(!InpDryRun && !trade.PositionModify(ticket, want, curTP))
            Print("#",sid," SL move FAILED: ",trade.ResultRetcodeDescription()," (will retry next tick)");
      }
   }
}

//------------------------------------------------------------------ close reporting
// When a position we opened disappears, read its realized P&L + exit price from
// deal history and PATCH the executions row so the ledger shows the REAL outcome
// (not just the entry). Purely observational — never touches orders.
void ReportOneClose(long posId, long sid)
{
   if(sid<0) return;
   if(!HistorySelectByPosition(posId)) return;
   double profit=0, exitPx=0; int outs=0; int total=HistoryDealsTotal();
   for(int i=0;i<total;i++){
      ulong d=HistoryDealGetTicket(i);
      if(d==0) continue;
      profit += HistoryDealGetDouble(d,DEAL_PROFIT)+HistoryDealGetDouble(d,DEAL_SWAP)+HistoryDealGetDouble(d,DEAL_COMMISSION);
      if(HistoryDealGetInteger(d,DEAL_ENTRY)==DEAL_ENTRY_OUT){ exitPx=HistoryDealGetDouble(d,DEAL_PRICE); outs++; }
   }
   if(outs==0) return;   // not actually closed yet
   string st=(MathAbs(profit)<0.01?"breakeven":"closed");
   string body="{\"status\":\""+st+"\",\"profit\":"+DoubleToString(profit,2)+",\"exit_fill\":"+DoubleToString(exitPx,2)+"}";
   if(HttpSend("PATCH",InpSupabaseUrl+"/rest/v1/executions?signal_id=eq."+(string)sid,body))
      Print("#",sid," CLOSE reported: ",st," profit=",DoubleToString(profit,2)," exit=",DoubleToString(exitPx,2));
}

void ReportCloses()
{
   if(InpDryRun) return;
   long curPos[]; long curSid[]; int cn=0;
   for(int i=PositionsTotal()-1;i>=0;i--){
      ulong tk=PositionGetTicket(i);
      if(!PositionSelectByTicket(tk)) continue;
      if(PositionGetInteger(POSITION_MAGIC)!=InpMagic) continue;
      ArrayResize(curPos,cn+1); ArrayResize(curSid,cn+1);
      curPos[cn]=(long)PositionGetInteger(POSITION_IDENTIFIER);
      curSid[cn]=SidFromComment(PositionGetString(POSITION_COMMENT));
      cn++;
   }
   // any position open last tick but not now -> it closed -> report once
   for(int j=0;j<ArraySize(g_openPos);j++){
      bool stillOpen=false;
      for(int k=0;k<cn;k++) if(curPos[k]==g_openPos[j]){ stillOpen=true; break; }
      if(!stillOpen) ReportOneClose(g_openPos[j], g_openSid[j]);
   }
   // remember the current open set for next tick
   ArrayResize(g_openPos,cn); ArrayResize(g_openSid,cn);
   for(int k=0;k<cn;k++){ g_openPos[k]=curPos[k]; g_openSid[k]=curSid[k]; }
}

//------------------------------------------------------------------ heartbeat (status + broker price + equity)
void Heartbeat()
{
   double bid=SymbolInfoDouble(g_sym,SYMBOL_BID), ask=SymbolInfoDouble(g_sym,SYMBOL_ASK);
   string body="{\"id\":"+(string)InpStatusId+",\"label\":\""+InpLabel+"\",\"account\":\""+(string)AccountInfoInteger(ACCOUNT_LOGIN)+
     "\",\"symbol\":\""+g_sym+"\",\"bid\":"+DoubleToString(bid,2)+",\"ask\":"+DoubleToString(ask,2)+
     ",\"open_positions\":"+(string)CountMine()+
     ",\"equity\":"+DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2)+
     ",\"balance\":"+DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2)+"}";
   HttpSend("POST", InpSupabaseUrl+"/rest/v1/mt5_status", body, "resolution=merge-duplicates,return=minimal");
}

//------------------------------------------------------------------ poll
void Poll()
{
   string done;
   if(!HttpGet(InpSupabaseUrl+"/rest/v1/executions?select=signal_id",done)){ g_status="exec read failed"; Status(); return; }
   string sig;
   // "manual"/"simon"/empty => Simon's manually-raised signals (source IS NULL); otherwise an exact source match
   string srcClause=(InpSource=="" || InpSource=="manual" || InpSource=="simon") ? "source=is.null" : "source=eq."+Enc(InpSource);
   string url=InpSupabaseUrl+"/rest/v1/signals?"+srcClause+
              "&status=eq.open&select=id,direction,entry_price,stop_loss,tp1,tp2,tp3&order=id.asc";
   if(!HttpGet(url,sig)){ g_status="signal read failed"; Status(); return; }

   string lines[]; int n=StringSplit(sig,'\n',lines);
   for(int i=1;i<n;i++){
      string row=Trim(lines[i]); if(StringLen(row)==0) continue;
      string f[]; int m=StringSplit(row,',',f);
      if(m<4) continue;
      long id=(long)StringToInteger(Trim(f[0]));
      if(id<=g_startMaxId) continue;
      if(Acted(id)) continue;
      if(IsDone(done,id)) continue;
      TryPlace(id, Trim(f[1]), StringToDouble(Trim(f[2])), StringToDouble(Trim(f[3])),
               (m>4 && StringLen(Trim(f[4]))>0)?StringToDouble(Trim(f[4])):0,
               (m>5 && StringLen(Trim(f[5]))>0)?StringToDouble(Trim(f[5])):0,
               (m>6 && StringLen(Trim(f[6]))>0)?StringToDouble(Trim(f[6])):0);
   }
   g_status="ok, watching (open="+(string)CountMine()+", startMaxId="+(string)g_startMaxId+")";
   Status();
}

void Status()
{
   Comment("Halyard copier RATCHET "+(InpDryRun?"[DRY_RUN]":"[LIVE]")+"\n"+
           TimeToString(TimeLocal(),TIME_DATE|TIME_SECONDS)+"\n"+
           "symbol="+g_sym+"  risk="+DoubleToString(InpRiskPct,2)+"%  maxExp="+DoubleToString(InpMaxExposurePct,1)+"%\n"+g_status);
}

void PrewarmCache()
{
   for(int i=PositionsTotal()-1;i>=0;i--){
      ulong t=PositionGetTicket(i);
      if(!PositionSelectByTicket(t)) continue;
      if(PositionGetInteger(POSITION_MAGIC)!=InpMagic) continue;
      long sid=SidFromComment(PositionGetString(POSITION_COMMENT));
      if(sid<0) continue;
      double e,sl,t1,t2,t3; GetLevels(sid,e,sl,t1,t2,t3);
      MarkActed(sid);
   }
}

int OnInit()
{
   g_sym=(StringLen(InpSymbol)>0?InpSymbol:_Symbol);
   if(!SymbolSelect(g_sym,true)){ Print("ERROR: symbol not found: ",g_sym); return INIT_FAILED; }
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(50);
   trade.SetTypeFillingBySymbol(g_sym);
   g_startMaxId=FetchMaxId();
   if(g_startMaxId<0)
      Print("WARNING: could not read Supabase. Whitelist ",InpSupabaseUrl,
            " in Tools>Options>Expert Advisors>Allow WebRequest, and enable Algo Trading.");
   PrewarmCache();
   Print("Halyard RATCHET ready. symbol=",g_sym," startMaxId=",g_startMaxId,
         " risk=",InpRiskPct,"% maxExp=",InpMaxExposurePct,"% ",(InpDryRun?"[DRY_RUN]":"[LIVE]"));
   EventSetTimer(InpPollSeconds);
   Heartbeat();
   Status();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason){ EventKillTimer(); Comment(""); }
void OnTimer(){ Poll(); ManageRatchet(); ReportCloses(); Heartbeat(); }
//+------------------------------------------------------------------+
