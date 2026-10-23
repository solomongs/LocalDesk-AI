import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {prebuiltAppConfig} from '@mlc-ai/web-llm';

// Rebuild metadata from the pinned WebLLM package. --refresh fetches only small
// weight manifests, never model weights. Default mode reuses recorded manifests.
const output='src/core/mobile-models.generated.json';
const runtimeVersion=JSON.parse(fs.readFileSync('node_modules/@mlc-ai/web-llm/package.json','utf8')).version;
const pinnedVersion=JSON.parse(fs.readFileSync('package.json','utf8')).dependencies['@mlc-ai/web-llm'];
if(runtimeVersion!==pinnedVersion)throw new Error('Installed WebLLM must exactly match the pinned package version before generating its catalog.');
const refresh=process.argv.includes('--refresh');
const metadataFile=process.argv.find(value=>value.startsWith('--metadata='))?.slice('--metadata='.length);
const previous=fs.existsSync(output)?JSON.parse(fs.readFileSync(output,'utf8')):{};
const manifests=metadataFile?JSON.parse(fs.readFileSync(metadataFile,'utf8')):(previous.manifests??{});
const manifestUrl=model=>`${model.replace(/\/$/,'')}/resolve/main/tensor-cache.json`;
const records=prebuiltAppConfig.model_list;
if(new Set(records.map(record=>record.model_id)).size!==records.length)throw new Error('WebLLM catalog has duplicate IDs.');
if(records.some(record=>!Number.isFinite(record.vram_required_MB)||record.vram_required_MB<=0))throw new Error('WebLLM memory metadata is missing; review before publishing.');
if(refresh){
 const urls=[...new Set(records.map(record=>manifestUrl(record.model)))];let next=0;
 await Promise.all(Array.from({length:6},async()=>{
  while(next<urls.length){
   const url=urls[next++];
   try{
    const response=await fetch(url,{headers:{'User-Agent':'LocalDeskCatalog/1.0'},signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const manifest=await response.json();
    const shards=(manifest.records??[]).filter(record=>Number.isFinite(record.nbytes)&&record.nbytes>=0);
    const bytes=shards.reduce((sum,shard)=>sum+shard.nbytes,0);
    if(!bytes||!shards.length)throw new Error('No weight shard sizes');
    manifests[url]={weightBytes:bytes,weightShardCount:shards.length,source:url};
   }catch(error){
    // Keep a previously verified manifest rather than downgrading on an outage.
    manifests[url]??={error:String(error.message??error)};
   }
  }
 }));
}
const publishers=[
 [/^DeepSeek/i,'DeepSeek','https://huggingface.co/deepseek-ai'],
 [/^Hermes/i,'Nous Research','https://huggingface.co/NousResearch'],
 [/^OpenHermes/i,'Teknium','https://huggingface.co/teknium'],
 [/^NeuralHermes/i,'mlabonne','https://huggingface.co/mlabonne'],
 [/^WizardMath/i,'WizardLM','https://huggingface.co/WizardLMTeam'],
 [/^Llama/i,'Meta','https://huggingface.co/meta-llama'],
 [/^SmolLM/i,'Hugging Face','https://huggingface.co/HuggingFaceTB'],
 [/^gemma/i,'Google','https://huggingface.co/google'],
 [/^OLMo/i,'Allen Institute for AI','https://huggingface.co/allenai'],
 [/^Qwen/i,'Alibaba / Qwen','https://huggingface.co/Qwen'],
 [/^Phi/i,'Microsoft','https://huggingface.co/microsoft'],
 [/^(Mistral|Ministral)/i,'Mistral AI','https://huggingface.co/mistralai'],
 [/^stablelm/i,'Stability AI','https://huggingface.co/stabilityai'],
 [/^RedPajama/i,'Together AI','https://huggingface.co/togethercomputer'],
 [/^TinyLlama/i,'TinyLlama Project','https://huggingface.co/TinyLlama'],
 [/^snowflake/i,'Snowflake','https://huggingface.co/Snowflake'],
];
function familyFor(id){return id.replace(/-q\d+f\d+(?:_\d+)?-MLC.*$/i,'').replace(/_/g,'.').replace(/-/g,' ').replace(/^gemma/i,'Gemma').replace(/^phi/i,'Phi').replace(/^stablelm/i,'StableLM').replace(/^snowflake/i,'Snowflake');}
function parametersFor(id){
 const match=id.match(/(?:^|-)(\d+(?:[._]\d+)?)([bm])(?=-|$)/i);
 if(match)return `${match[1].replace('_','.')} ${match[2].toLowerCase()==='b'?'billion':'million'}`;
 if(/^phi-1_5/i.test(id))return '1.3 billion';
 if(/^phi-2/i.test(id))return '2.7 billion';
 if(/^Phi-(?:3(?:\.5)?-mini|4-mini)/i.test(id))return '3.8 billion';
 if(/^Phi-3\.5-vision/i.test(id))return '4.2 billion';
 if(/^gemma-4-E2B/i.test(id))return 'E2B effective-size variant';
 if(/embed-m/.test(id))return 'Medium embedding variant';
 if(/embed-s/.test(id))return 'Small embedding variant';
 return 'See model card';
}
function inferredParameters(id){
 const match=id.match(/(?:^|-)(\d+(?:[._]\d+)?)([bm])(?=-|$)/i);
 if(match)return Number(match[1].replace('_','.'))*(match[2].toLowerCase()==='b'?1e9:1e6);
 if(/^phi-1_5/i.test(id))return 1.3e9;
 if(/^phi-2/i.test(id))return 2.7e9;
 if(/^Phi-(?:3(?:\.5)?-mini|4-mini)/i.test(id))return 3.8e9;
 if(/^Phi-3\.5-vision/i.test(id))return 4.2e9;
 return null;
}
function detailsFor(record){
 const id=record.model_id;
 if(record.model_type===1)return {category:'Embeddings',useCaseTags:['Embeddings','Search'],summary:'An embedding model that turns text into numerical vectors for semantic search. It does not generate chat replies.',useCases:['Semantic search and document matching','Retrieval features in applications','Grouping similar text'],limitations:['Listed for catalog completeness. This chat app does not currently run embedding tasks.'],examplePrompt:'Find documents related to a search query.',exampleResponse:'Embedding output is a vector of numbers, not a conversational answer.'};
 if(record.model_type===2)return {category:'Vision',useCaseTags:['Vision','Study'],summary:'A vision-language model for understanding text and images in applications with image input.',useCases:['Explain image content in a supported vision app','Answer questions about visual material','Combine text and visual context'],limitations:['Listed for catalog completeness. Image input is not available in this version of LocalDesk mobile chat.'],examplePrompt:'Describe the main objects in an image.',exampleResponse:'This requires image input in a compatible vision application; it is not a live preview.'};
 if(/Coder/i.test(id))return {category:'Coding',useCaseTags:['Coding','Study'],summary:'A coding-focused assistant for explaining snippets, drafting small functions and learning programming.',useCases:['Explain pasted code','Draft small functions','Debug a short snippet'],limitations:['Generated code can be incorrect or insecure; test and review it.','Large repository work can exceed mobile context and memory limits.'],examplePrompt:'Explain how a set differs from a list in Python.',exampleResponse:'A list keeps its order and permits duplicates. A set stores unique items and is useful for membership checks.'};
 if(/Math/i.test(id))return {category:'Math',useCaseTags:['Math','Study','Reasoning'],summary:'A mathematics-focused model for working through quantitative examples and explaining steps.',useCases:['Explain a maths method','Work through a practice problem','Compare numerical approaches'],limitations:['Check calculations independently. A reasoning-style answer is not proof that a result is correct.'],examplePrompt:'Explain why 3 × (4 + 2) equals 18.',exampleResponse:'Calculate inside the parentheses first: 4 + 2 = 6. Then multiply 3 × 6 = 18.'};
 if(/DeepSeek|Reasoning|^Qwen3(?:\.|-)/i.test(id))return {category:'Reasoning',useCaseTags:['Reasoning','Study','Coding','Writing'],summary:'A reasoning-oriented text model for planning, explaining ideas and comparing possible approaches.',useCases:['Break a problem into smaller steps','Compare options','Explain a technical concept'],limitations:['Reasoning can be slow and lengthy on a phone.','The mobile response limit can cut a long answer short. Verify facts and calculations.'],examplePrompt:'Plan three steps for learning a new topic.',exampleResponse:'1. Identify the basics. 2. Practise with a small example. 3. Review mistakes and explain what you learned.'};
 if(/-Base-|^phi-(1_5|2)-/i.test(id))return {category:'Writing',useCaseTags:['Writing','Text completion'],summary:'A base text-completion model for continuing short passages and experimenting with language generation.',useCases:['Continue a passage','Try short text completion','Explore base-model behavior'],limitations:['Base models are not tuned to follow chat instructions reliably.','For normal conversation, choose an Instruct or Chat variant.'],examplePrompt:'Continue: A useful way to organize my notes is',exampleResponse:'to group related ideas, add clear headings and keep a short summary of the main points.'};
 if(/Qwen|jpn/i.test(id))return {category:'Study',useCaseTags:['Everyday chat','Writing','Study','Translation'],summary:'A multilingual text assistant for short explanations, rewriting and organizing notes.',useCases:['Explain a topic simply','Draft or rewrite text','Translate a short passage and review it'],limitations:['Language quality varies by model size and language.','Check factual claims and translations before relying on them.'],examplePrompt:'Rewrite this politely: Send the notes today.',exampleResponse:'Could you please send the notes today? Thank you.'};
 return {category:'Everyday',useCaseTags:['Everyday chat','Writing','Study'],summary:'A local text assistant for everyday questions, short drafts, summaries and brainstorming.',useCases:['Draft a short email','Summarize pasted text','Brainstorm ideas'],limitations:['Small models have limited factual and reasoning accuracy.','This model does not browse the web. Verify important answers.'],examplePrompt:'Write a friendly reminder to bring a notebook tomorrow.',exampleResponse:'Quick reminder: please bring your notebook tomorrow. See you then!'};
}
const models=records.map(record=>{
 const id=record.model_id;const family=familyFor(id);
 const [,,companySource]=publishers.find(([pattern])=>pattern.test(id))??[/./,'MLC community','https://huggingface.co/mlc-ai'];
 const company=(publishers.find(([pattern])=>pattern.test(id))??[])[1]??'MLC community';
 const quantization=id.match(/q\d+f\d+(?:_\d+)?/i)?.[0]??'See model card';
 const contextWindow=record.overrides?.context_window_size??(/-1k$/.test(id)?1024:4096);
 const suffix=/-1k$/.test(id)?' · 1K context':/-b\d+$/.test(id)?` · batch ${id.match(/-b(\d+)$/)[1]}`:'';
 const candidate=manifests[manifestUrl(record.model)];
 const known=Number.isSafeInteger(candidate?.weightBytes)&&candidate.weightBytes>0?candidate:undefined;
 const count=inferredParameters(id);
 const bits=Number(quantization.match(/^q(\d+)/)?.[1]);
 const estimatedBytes=count?count*(bits===0?(quantization.includes('f32')?4:2):(bits===3?0.44:0.63)):record.vram_required_MB*1e6*0.7;
 const downloadBytes=known?.weightBytes??Math.round(estimatedBytes);
 const modelType=record.model_type===1?'embedding':record.model_type===2?'vision':'chat';
 const requiredFeatures=[...new Set([...(record.required_features??[]),...(/f16/i.test(quantization)?['shader-f16']:[])])];
 return {id,name:`${family} · ${quantization}${suffix}`,family,company,companySource,parameters:parametersFor(id),quantization,modelType,chatLoadable:modelType==='chat',downloadGB:downloadBytes/1e9,downloadBytes,downloadSource:known?.weightBytes?'manifest':'estimated',downloadManifest:manifestUrl(record.model),downloadNote:known?.weightBytes?'Model weights from the upstream manifest. Tokenizer, runtime and optional assets need additional storage.':'Estimated model weights. Tokenizer, runtime and optional assets need additional storage.',runtimeMemoryGB:record.vram_required_MB/1000,memorySource:'webllm',contextWindow,requiredFeatures,...(record.buffer_size_required_bytes?{bufferSizeRequiredBytes:record.buffer_size_required_bytes}:{}),advanced:record.vram_required_MB>2500,source:record.model,...detailsFor(record)};
});
const doc={runtimeVersion,source:`https://github.com/mlc-ai/web-llm/blob/v${runtimeVersion}/src/config.ts`,catalogSha256:createHash('sha256').update(JSON.stringify(records)).digest('hex'),units:'Decimal GB (1 GB = 1,000,000,000 bytes); WebLLM MB / 1000 for estimated runtime memory.',manifests,models};
fs.writeFileSync(output,JSON.stringify(doc,null,2)+'\n');
console.log(`Generated ${models.length} model variants (${models.filter(m=>m.chatLoadable).length} chat-ready), ${models.filter(m=>m.downloadSource==='manifest').length} manifest-backed weight sizes.`);
