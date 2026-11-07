export async function requestService(baseUrl:string,token:string,method:string,route:string,body?:any){
 if(!/^\/v1\/[a-zA-Z0-9/?=&_.%-]*$/.test(route)||!['GET','POST','PATCH','DELETE'].includes(method))throw Error('Invalid API request.');
 const headers:Record<string,string>={Authorization:'Bearer '+token};if(body!==undefined)headers['Content-Type']='application/json';
 const response=await fetch(baseUrl+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(200000),redirect:'error'});
 if(response.headers.get('content-type')?.startsWith('image/'))return {base64:Buffer.from(await response.arrayBuffer()).toString('base64'),mime:response.headers.get('content-type')};
 const data=await response.json() as any;if(!response.ok)throw Error(data.error||'Request failed: '+response.status);return data;
}
