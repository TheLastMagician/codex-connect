import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {home,readConfig,providerList,requireSelection,launcherDefaults} from './providers.mjs';
import {projectChoices,projectDirectory} from './projects.mjs';
import {existingThreadId} from './service.mjs';

export const SETTINGS_READ_OUTPUT={type:'object',properties:{schema:{type:'object'},values:{type:'object'},layout:{type:'array',items:{type:'object'}}},required:['schema','values']};
export const SETTINGS_UPDATE_INPUT={type:'object',properties:{set:{type:'object',properties:{providerId:{type:'string'},model:{type:'string'},effort:{type:'string'},project:{type:'string'},title:{type:'string'},editThread:{type:'string'},editProvider:{type:'string'},editModel:{type:'string'},editEffort:{type:'string'}},minProperties:1,additionalProperties:false}},required:['set'],additionalProperties:false};
const EFFORTS=['none','minimal','low','medium','high','xhigh','max','ultra'];
export class NativeSettings {
  constructor(service,{directory=path.join(home(),'model-switcher'),read=readConfig}={}){Object.assign(this,{service,directory,read});}
  file(){return path.join(this.directory,'settings.json');}
  stored(){try{return JSON.parse(fs.readFileSync(this.file(),'utf8'));}catch(error){if(error.code==='ENOENT')return{};throw new Error('本机插件设置无法读取。');}}
  values(){const config=this.read(),saved=this.stored(),providers=providerList(config).providers,defaults=launcherDefaults(config);
    const providerId=providers.some(p=>p.id===saved.providerId)?saved.providerId:defaults.providerId;
    return {providerId,model:saved.model||defaults.model,effort:saved.effort||defaults.effort,title:saved.title||'新会话',
      editThread:saved.editThread||'',editProvider:saved.editProvider||defaults.providerId,editModel:saved.editModel||'qwen3.8-27b',editEffort:saved.editEffort||'xhigh'};
  }
  async selection(){
    const projects=await this.service.projects(),choices=projectChoices(projects),saved=this.stored();
    const choice=choices.find(p=>p.projectId===saved.projectId&&p.cwd===saved.cwd)||choices.find(p=>p.projectId===saved.projectId)||(!saved.projectId&&choices.find(p=>p.cwd===saved.cwd))||(!saved.projectId&&choices.find(p=>p.cwd===process.cwd()))||(!saved.projectId&&choices[0]);
    return {projects,choices,choice};
  }
  async get(){const config=this.read(),{choices,choice}=await this.selection();return {schema:{type:'object',properties:{
    providerId:{type:'string',title:'供应商',description:providerList(config).providers.map(p=>`${p.id}：${p.name}`).join('；'),enum:providerList(config).providers.map(p=>p.id)},
    model:{type:'string',title:'模型 ID',description:'OpenAI 列表来自 Codex model/list；第三方来自所选供应商的 /models。可在模型选择面板查看，也可填写完整模型 ID。',minLength:1,maxLength:160},
    effort:{type:'string',title:'思考强度',description:'按所选值传给供应商，例如 xhigh；实际支持和预算由供应商决定。',enum:EFFORTS},
    project:{type:'string',title:'所属项目',description:'实时读取 Codex 本机已有项目。新会话保存项目归属，工作目录使用该项目路径。',enum:[...(!choice?['请选择项目']:[]),...choices.map(p=>p.label)]},
    title:{type:'string',title:'新会话标题',minLength:1,maxLength:100},
    editThread:{type:'string',title:'已有会话链接或 ID',description:'粘贴 codex://threads/ 链接；也可打开模型面板，从已有会话列表选择。'},
    editProvider:{type:'string',title:'会话原供应商',description:'必须与该会话保存的供应商一致。',enum:providerList(config).providers.map(p=>p.id)},
    editModel:{type:'string',title:'修改为模型',minLength:1,maxLength:160},
    editEffort:{type:'string',title:'修改为思考强度',enum:EFFORTS}
  },required:['providerId','model','effort','project','title']},values:{...this.values(),project:choice?.label||'请选择项目'},layout:[
    {kind:'group',title:'新建会话的连接',items:[{kind:'property',property:'providerId'},{kind:'property',property:'model'},{kind:'property',property:'effort'},{kind:'tool',tool:'open_model_panel',description:'在 Codex 内打开模型选择面板。'}]},
    {kind:'group',title:'新会话',items:[{kind:'property',property:'project'},{kind:'property',property:'title'},{kind:'tool',tool:'launch_from_settings',description:'在所选项目中新建真实会话并打开，不发送首条消息。'}]},
    {kind:'group',title:'修改已有会话模型',items:[{kind:'property',property:'editThread'},{kind:'property',property:'editProvider'},{kind:'property',property:'editModel'},{kind:'property',property:'editEffort'},{kind:'tool',tool:'modify_from_settings',description:'修改模型并核对历史模型记录；仅验证设置。旧模型压缩失败时需在原会话执行 /compact，本操作不自动压缩或发送消息。'}]}
  ]};}
  async update(set){
    if(!set||typeof set!=='object'||Array.isArray(set)||!Object.keys(set).length)throw new Error('没有可更新的设置。');
    const editKeys=['editThread','editProvider','editModel','editEffort'];
    const allowed=['providerId','model','effort','project','title',...editKeys];
    if(Object.entries(set).some(([key,value])=>!allowed.includes(key)||typeof value!=='string'))throw new Error('无效的插件设置。');
    const editValues={...this.values(),...set};
    if(Object.keys(set).some(key=>editKeys.includes(key))){
      requireSelection(this.read(),editValues.editProvider,editValues.editModel);
      if(!EFFORTS.includes(editValues.editEffort))throw new Error('无效的思考强度。');
      if(editValues.editThread)existingThreadId(editValues.editThread);
    }
    if(Object.keys(set).every(key=>editKeys.includes(key))){
      const saved=this.stored(),data={...saved,...Object.fromEntries(editKeys.map(key=>[key,editValues[key]]))};
      const project=(await this.selection()).choice?.label||'请选择项目';
      this.write(data);return {values:{...this.values(),project}};
    }
    const old=this.values(),{projects,choices,choice}=await this.selection(),values={...old,...set},config=this.read(),saved=this.stored();
    const selected=Object.hasOwn(set,'project')?choices.find(p=>p.label===set.project):choice;
    if(!selected)throw new Error('请选择 Codex 已有的本机项目，或刷新项目列表。');
    projectDirectory(projects.find(p=>p.id===selected.projectId),selected.cwd);
    if(values.providerId!==old.providerId&&!Object.hasOwn(set,'model')){
      const items=(await this.service.models(values.providerId)).models;
      const remembered=saved.modelsByProvider?.[values.providerId];
      values.model=items.find(m=>m.id===remembered)?.id||items.find(m=>m.id===config.model)?.id||items.find(m=>m.id==='qwen3.8-27b')?.id||items[0]?.id||'';
      if(!Object.hasOwn(set,'effort'))values.effort=saved.effortsByProvider?.[values.providerId]||(values.providerId==='openai'?items.find(m=>m.id===values.model)?.defaultEffort||'low':'xhigh');
    }
    requireSelection(config,values.providerId,values.model);
    if(!EFFORTS.includes(values.effort))throw new Error('无效的思考强度。');
    if(!values.title.trim()||values.title.length>100)throw new Error('标题需要 1–100 个字符。');
    values.project=selected.label;
    const data={...values,projectId:selected.projectId,cwd:selected.cwd,modelsByProvider:{...saved.modelsByProvider,[values.providerId]:values.model},effortsByProvider:{...saved.effortsByProvider,[values.providerId]:values.effort}};
    this.write(data);return {values};
  }
  write(data){fs.mkdirSync(this.directory,{recursive:true,mode:0o700});const tmp=this.file()+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data),{mode:0o600});fs.renameSync(tmp,this.file());}
  modify(){const values=this.values();return this.service.modifyExisting({threadRef:values.editThread,providerId:values.editProvider,model:values.editModel,effort:values.editEffort});}
  async launch(){
    const {choice}=await this.selection();
    if(!choice)throw new Error('所选项目已不存在，请刷新后重新选择。');
    return this.service.create({operationId:randomUUID(),...this.values(),projectId:choice.projectId,cwd:choice.cwd});
  }
}
