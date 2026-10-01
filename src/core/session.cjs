const path=require('node:path');
const fs=require('node:fs');
const {Worker}=require('node:worker_threads');
const {randomUUID}=require('node:crypto');
class DocumentSession {
  constructor(resources,onProgress=()=>{}){this.resources=resources;this.onProgress=onProgress;this.current=null;this.undoStack=[];this.redoStack=[];this.active=null;this.saving=false;}
  info(){return {dirty:!!this.current?.dirty,canUndo:this.undoStack.length>0,canRedo:this.redoStack.length>0,filePath:this.current?.filePath||''};}
  async run(options){
    if(this.active||this.saving)throw new Error('正在处理投影，请等待完成。');
    return new Promise((resolve,reject)=>{
      const worker=new Worker(path.join(__dirname,'worker.cjs'),{workerData:{...this.resources(),...options}});this.active=worker;
      let settled=false;const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);this.active=null;worker.terminate();error?reject(error):resolve(result);};
      const timer=setTimeout(()=>finish(new Error('处理超过 120 秒，已停止。')),120000);
      worker.on('message',m=>{if(m.progress)this.onProgress(m.progress);if(m.error)finish(new Error(m.error));if(m.result)finish(null,m.result);});
      worker.on('error',e=>finish(e));worker.on('exit',code=>{if(!settled)finish(new Error(`处理进程退出 (${code})`));});
    });
  }
  commit(result,dirty){const buffer=Buffer.from(result.documentBuffer);delete result.documentBuffer;this.current={buffer,filePath:result.filePath,dirty:this.savedBuffer?!buffer.equals(this.savedBuffer):dirty};result.document=this.info();return result;}
  async load(filePath){const result=await this.run({filePath});this.undoStack=[];this.redoStack=[];this.savedBuffer=Buffer.from(result.documentBuffer);return this.commit(result,false);}
  async reload(){this.requireCurrent();return this.commit(await this.run(this.current),this.current.dirty);}
  requireCurrent(){if(!this.current)throw new Error('请先打开投影。');if(this.active||this.saving)throw new Error('正在处理投影，请等待完成。');}
  async replace(request){this.requireCurrent();const result=await this.run({...this.current,operation:'replace',request});if(result.editSummary.changed){this.undoStack.push(this.current);this.redoStack=[];let bytes=this.undoStack.reduce((s,d)=>s+d.buffer.length,0);while(this.undoStack.length>20||bytes>128*1024*1024&&this.undoStack.length>1)bytes-=this.undoStack.shift().buffer.length;}return this.commit(result,this.current.dirty||result.editSummary.changed>0);}
  async history(kind){this.requireCurrent();const stack=kind==='undo'?this.undoStack:this.redoStack,other=kind==='undo'?this.redoStack:this.undoStack;if(!stack.length)return null;const previous=stack[stack.length-1],result=await this.run({...previous,filePath:this.current.filePath});stack.pop();other.push(this.current);return this.commit(result,true);}
  async save(file){
    this.requireCurrent();
    // Lock before the first await: load, history and replace must not commit a
    // different document while these exact bytes are being written to disk.
    const current=this.current,buffer=Buffer.from(current.buffer),temp=file+'.'+process.pid+'.'+randomUUID()+'.tmp';
    this.saving=true;
    try{
      await fs.promises.writeFile(temp,buffer,{flag:'wx'});
      await fs.promises.rename(temp,file);
      this.savedBuffer=buffer;
      current.filePath=file;
      current.dirty=!current.buffer.equals(buffer);
      return {...this.info(),savedPath:file};
    }catch(e){
      try{await fs.promises.unlink(temp);}catch{}
      throw e;
    }finally{this.saving=false;}
  }
  dispose(){this.active?.terminate();}
}
module.exports={DocumentSession};
