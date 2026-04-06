/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {        
    async fetch(request, env) {                                                                                                   
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",                                                                                                     
        "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",                                                                                         
      };                                                     
                                                                                                                                                
      if (request.method === "OPTIONS") {                    
        return new Response(null, { headers: corsHeaders });
      }                                                                                                                                         
   
      const shopName = "6kaf1n-gt";                                                                                                             
      const accessToken = env.SHOPIFY_TOKEN;                 
      const baseUrl = `https://${shopName}.myshopify.com/admin/api/2024-01`;
                                                                                                                                                
      const url = new URL(request.url);                                                                                                         
      const id = url.searchParams.get("id");                                                                                                    
      const action = url.searchParams.get("action");                                                                                            
                                                             
      // GET /?id={draft_order_id} — 取得 draft order 詳情                                                                                      
      if (request.method === "GET") {
        if (!id) {                                                                                                                              
          return new Response(JSON.stringify({ error: "Missing id" }), {
            status: 400,                                                                                                                        
            headers: { ...corsHeaders, "Content-Type": "application/json" },                                                                    
          });
        }                                                                                                                                       
                                                             
        try {
          const res = await fetch(`${baseUrl}/draft_orders/${id}.json`, {
            headers: {
              "Content-Type": "application/json",                                                                                               
              "X-Shopify-Access-Token": accessToken,
            },                                                                                                                                  
          });                                                
          const data = await res.json();
          return new Response(JSON.stringify(data), {
            status: res.status,                                                                                                                 
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });                                                                                                                                   
        } catch (err) {                                      
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500,                                                                                                                        
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });                                                                                                                                   
        }                                                    
      }

      // PUT /?id={draft_order_id}&action=complete — 完成 draft order → 建立正式訂單                                                            
      if (request.method === "PUT" && action === "complete") {
        if (!id) {                                                                                                                              
          return new Response(JSON.stringify({ error: "Missing id" }), {
            status: 400,                                                                                                                        
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });                                                                                                                                   
        }                                                    

        try {
          const res = await fetch(`${baseUrl}/draft_orders/${id}/complete.json`, {
            method: "PUT",                                                                                                                      
            headers: {
              "Content-Type": "application/json",                                                                                               
              "X-Shopify-Access-Token": accessToken,         
            },
          });
          const data = await res.json();                                                                                                        
          return new Response(JSON.stringify(data), {
            status: res.status,                                                                                                                 
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), {                                                                         
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },                                                                    
          });                                                
        }
      }

      // POST / — 建立 draft order                                                                                                              
      if (request.method === "POST") {
        try {                                                                                                                                   
          const cartData = await request.json();             
          console.log(">>> [Incoming Data] Email:", cartData.email);
                                                                                                                                                
          const res = await fetch(`${baseUrl}/draft_orders.json`, {
            method: "POST",                                                                                                                     
            headers: {                                       
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": accessToken,                                                                                            
            },
            body: JSON.stringify({                                                                                                              
              draft_order: {                                 
                line_items: cartData.items.map((item) => ({
                  variant_id: item.variant_id || item.id,
                  quantity: item.quantity,                                                                                                      
                })),
                email: cartData.email,                                                                                                          
                customer: {                                  
                  id: cartData.customerId,
                },
                shipping_address: {
                  address1: cartData.address?.address1,
                  city: cartData.address?.city || "No City",                                                                                    
                  country: cartData.address?.country || "TW",
                  zip: cartData.address?.zip || "20878",                                                                                        
                },                                           
                tags: cartData.tags,
              },                                                                                                                                
            }),
          });                                                                                                                                   
                                                             
          const result = await res.json();
          return new Response(JSON.stringify(result), {
            status: res.status,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });                                                                                                                                   
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), {                                                                         
            status: 500,                                     
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
                                                                                                                                                
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    },                                                                                                                                          
  };  