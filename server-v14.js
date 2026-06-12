/**
 * AI DesignKit Server v14 - Img2Img Support + Top Photographer Prompts
 * 核心升级：
 * 1. 支持 img2img（图生图）- 前端上传参考图，后端用 base64 调用 SiliconFlow
 * 2. 顶级摄影师 Prompt 优化 - 让 AI 生成像顶级摄影师拍的一样真实的图片
 * 3. 修复前端没有发送参考图的问题
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const https = require('https');

const app = express();
const PORT = 3001;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const TASKS_FILE = path.join(__dirname, 'tasks.json');
const GENERATED_DIR = path.join(__dirname, 'generated-images');
const ENGINE_CONFIG_FILE = path.join(__dirname, 'engine-config.json');

if (!fs.existsSync(GENERATED_DIR)) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

// ===== 多引擎配置 =====
var ENGINE_CONFIG = {
  siliconflow: {
    enabled: true,
    apiKey: '',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Kwai-Kolors/Kolors',  // 免费模型（时尚人像）
    paidModel: 'Tongyi-MAI/Z-Image-Turbo',  // 付费模型（电商产品图效果最好）
    fallbackModel: 'black-forest-labs/FLUX.1-schnell',
    label: 'SiliconFlow',
    usePaidModel: false  // 是否使用付费模型
  },
  agnes: {
    enabled: true,
    apiKey: '',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-image-2.1-flash',
    label: 'Agnes AI'
  },
  cogview: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'cogview-3-flash',
    label: 'CogView-3'
  },
  active: 'siliconflow'
};

function loadEngineConfig() {
  if (fs.existsSync(ENGINE_CONFIG_FILE)) {
    try {
      var saved = JSON.parse(fs.readFileSync(ENGINE_CONFIG_FILE, 'utf8'));
      ['siliconflow', 'agnes', 'cogview'].forEach(function(key) {
        if (saved[key] && saved[key].apiKey) {
          ENGINE_CONFIG[key].apiKey = saved[key].apiKey;
          ENGINE_CONFIG[key].enabled = true;
        }
        if (saved[key] && saved[key].model) ENGINE_CONFIG[key].model = saved[key].model;
      });
      if (saved.active) ENGINE_CONFIG.active = saved.active;
      console.log('[Config] 已加载引擎配置');
    } catch(e) {
      console.warn('[Config] 加载失败:', e.message);
    }
  }
}
loadEngineConfig();

// ============================================================
// 核心：中文产品描述 -> 精准英文视觉描述
// ============================================================

// 颜色对照表
var COLOR_MAP = {
  '白色':'pure white','黑色':'deep black','灰色':'medium gray','红色':'vibrant red',
  '蓝色':'royal blue','绿色':'forest green','黄色':'golden yellow','橙色':'bright orange',
  '粉色':'soft pink','紫色':'elegant purple','棕色':'warm brown','米色':'beige cream',
  '卡其色':'khaki tan','卡其':'khaki tan','藏青色':'navy blue','藏青':'navy blue',
  '酒红色':'burgundy wine','color red':'burgundy','驼色':'camel tan','camel':'camel',
  '墨绿色':'dark olive green','天蓝色':'sky blue','杏色':'apricot beige',
  '银色':'metallic silver','金色':'gold metallic','军绿色':'army olive green','military green':'olive green',
  '浅蓝':'light sky blue','深灰':'charcoal dark gray','浅灰':'light heather gray',
  '宝蓝':'royal blue','dark green':'dark green','orange':'orange','colorful':'multi-color'
};

// 材质对照表
var MATERIAL_MAP = {
  '纯棉':'100% premium cotton','cotton':'cotton fabric','denim':'denim','polyester':'polyester blend',
  '丝绸':'silk','linen':'linen','wool':'wool blend','knit':'knit fabric',
  '牛津纺':'oxford cloth','corduroy':'corduroy','velvet':'velvet','chiffon':'chiffon',
  '皮革':'genuine leather','PU':'PU leather','canvas':'canvas',
  'blend':'cotton-polyester blend','spandex':'spandex elastic','modal':'modal soft fabric',
  'nylon':'nylon','acrylic':'acrylic','tencel':'tencel','lycra':'lycra stretch'
};

// 服装类型对照表（最关键！）
var GARMENT_MAP = {
  '短裤':'casual shorts','pants':'full-length trousers','jeans':'denim jeans',
  'T恤':'cotton T-shirt','shirt':'button-up shirt','hoodie':'hoodie sweatshirt',
  '外套':'outerwear jacket','dress':'one-piece dress','skirt':'skirt',
  '背心':'tank top','sweater':'knit sweater','jacket':'zip-up jacket',
  '风衣':'trench coat','suit':'blazer suit jacket','joggers':'joggers sweatpants',
  'leggings':'leggings','wide-leg pants':'wide-leg palazzo pants','skinny pants':'skinny fitted pants',
  'cargo pants':'cargo pants with side pockets','chinos':'casual chinos','dress pants':'dress trousers',
  'bermuda shorts':'bermuda shorts above knee','capri':'capri pants below knee',
  'ankle pants':'ankle-length pants','vest':'vest','overcoat':'overcoat','puffer':'puffer jacket',
  'polo':'polo shirt','cardigan':'cardigan','pajamas':'pajama set','loungewear':'loungewear set'
};

// 风格/版型对照表
var STYLE_MAP = {
  '宽松':'loose relaxed fit','slim':'slim fitted cut','tight':'body-hugging tight fit',
  '直筒':'straight leg cut','cinched waist':'cinched waist','high-waisted':'high-waisted',
  'low-rise':'low-rise','ankle-length':'cropped ankle-length','knee-length':'knee-length',
  'above-knee':'above-knee bermuda length',
  'thin':'lightweight thin fabric','thick':'heavyweight thick warm',
  'breathable':'breathable fabric','stretchy':'stretchy elastic waist',
  'flowy':'flowy draping','structured':'structured crisp',
  'vintage':'vintage retro','minimalist':'minimalist clean','Korean':'Korean slim style',
  'Japanese':'Japanese relaxed','streetwear':'streetwear urban'
};

/**
 * 核心函数：将中文产品名+卖点 转换为 精准英文视觉描述
 * 返回：{ visualDesc, negativePrompt, garmentType }
 */
function enrichProductDescription(productName, sellingPoints) {
  var raw = (productName + ' ' + (sellingPoints || '')).trim();
  var parts = [];
  var negParts = [];
  var detectedGarment = null;

  // 1. 检测服装类型（最重要！）
  for (var g in GARMENT_MAP) {
    if (raw.indexOf(g) !== -1) {
      detectedGarment = g;
      parts.push(GARMENT_MAP[g]);
      break;
    }
  }

  // 2. 检测颜色
  for (var c in COLOR_MAP) {
    if (raw.indexOf(c) !== -1) {
      parts.push(COLOR_MAP[c] + ' color');
      negParts.push('wrong color');
      break;
    }
  }

  // 3. 检测材质
  for (var m in MATERIAL_MAP) {
    if (raw.indexOf(m) !== -1) {
      parts.push(MATERIAL_MAP[m] + ' material');
      break;
    }
  }

  // 4. 检测风格/版型
  for (var s in STYLE_MAP) {
    if (raw.indexOf(s) !== -1) {
      parts.push(STYLE_MAP[s]);
    }
  }

  // 5. 检测设计细节
  if (raw.indexOf('腰带') !== -1 || raw.indexOf('皮带') !== -1) parts.push('with belt loops');
  if (raw.indexOf('口袋') !== -1) parts.push('with functional side pockets');
  if (raw.indexOf('拉链') !== -1) parts.push('zipper fly closure');
  if (raw.indexOf('纽扣') !== -1) parts.push('button closure detail');
  if (raw.indexOf('刺绣') !== -1) parts.push('embroidery detail');
  if (raw.indexOf('印花') !== -1) parts.push('printed pattern');
  if (raw.indexOf('条纹') !== -1) parts.push('striped pattern');
  if (raw.indexOf('格子') !== -1) parts.push('plaid checkered pattern');
  if (raw.indexOf('纯色') !== -1) parts.push('solid color plain');
  if (raw.indexOf('磨毛') !== -1) parts.push('brushed soft inner');
  if (raw.indexOf('抗皱') !== -1) parts.push('wrinkle-resistant');
  if (raw.indexOf('加绒') !== -1 || raw.indexOf('加厚') !== -1) parts.push('fleece-lined warm');
  if (raw.indexOf('冰丝') !== -1 || raw.indexOf('凉感') !== -1) parts.push('cool-touch ice silk');

  // 6. 如果没有识别到服装类型，用产品名作为 fallback
  if (!detectedGarment) {
    parts.push('clothing item');
  }

  // 构建负面提示词
  var neg = 'NO suit, NO dress shirt, NO shoes, NO handbag, NO unrelated items, ';
  if (detectedGarment) {
    var allG = Object.keys(GARMENT_MAP);
    for (var i = 0; i < allG.length; i++) {
      if (allG[i] !== detectedGarment) {
        neg += 'NO ' + GARMENT_MAP[allG[i]].split(' ')[0] + ', ';
      }
    }
  }
  neg += 'no text, no watermark, no logo, no cartoon, not anime, not illustration, not 3d render';

  return {
    visualDesc: parts.join(', '),
    negativePrompt: neg,
    garmentType: detectedGarment
  };
}

// ============================================================
// 顶级摄影师 Prompt 模板（v14 - 极致真实感优化）
// ============================================================

function buildPrompt(type, productName, sellingPoints, refDescription) {
  var enriched = enrichProductDescription(productName, sellingPoints);
  var vDesc = enriched.visualDesc;
  var ref = refDescription ? ' Reference style: ' + refDescription + '.' : '';

  var prompts = {};

  // === 白底主图：纯产品图，亚马逊标准，顶级商业摄影 ===
  prompts['whitebg'] =
    'AWARD-WINNING professional e-commerce product photography of a single ' + vDesc + '. ' +
    'SHOT ON: Phase One IQ4 150MP medium format camera with 80mm Schneider Kreuznach leaf shutter lens. ' +
    'LIGHTING: Large 6-foot octabox softbox at 45-degree angle camera left, providing soft even illumination. ' +
    'Fill card below product to eliminate shadows. Pure white seamless background (#FFFFFF), zero gradient, zero color cast. ' +
    'CAMERA SETTINGS: f/11 for maximun depth of field, 1/125s, ISO 100, tripod-mounted, 2-second timer release. ' +
    'COMPOSITION: Product centered in frame occupying exactly 70% of image, eye-level straight-on angle. ' +
    'Sharp focus on entire product from closest to farthest point. Commercial catalog quality, 8K resolution, ' +
    'hyper-realistic fabric texture visible at pixel level. ' +
    'NEGATIVE PROMPT: ' + enriched.negativePrompt + ', no person, no mannequin, no hanger, product only, ' +
    'no cartoon, not anime, not illustration, photorealistic only, 100% real product photography.';

  // === 模特展示：顶级时尚摄影，让模特和产品都超级真实 ===
  prompts['model'] =
    'VOGUE-LEVEL high-end fashion e-commerce photography of a handsome young East Asian male model (age 25, fit athletic build, clean-shaven, natural skin texture visible). ' +
    'The model is wearing a ' + vDesc + '. ' +
    'CAMERA: Hasselblad H6D-100c with 80mm HC lens. MEDIUM FORMAT SENSOR for incredible detail. ' +
    'LIGHTING: Three-point studio lighting setup. ' +
    'Key light: Profoto B10 with 4-foot octa box at upper left 45 degrees. ' +
    'Fill light: Large white bounce card on right side, 2 stops below key. ' +
    'Rim light: Strip box behind model at head height, creating edge glow on hair and shoulders. ' +
    'Background: Neutral light gray (#E8E8E8) seamless paper roll. ' +
    'CAMERA SETTINGS: f/5.6 for shallow depth of field, 1/200s, ISO 50, natural skin tones. ' +
    'POSE: Full body standing, facing camera, natural relaxed stance with one hand in pocket, genuine expression. ' +
    'THE GARMENT: Must be exactly ' + vDesc + '. Correct color, correct style, correct fit. ' +
    'FABRIC TEXTURE: Every weave, stitch, and fold razor-sharp. ' +
    'SKIN: Pores, fine lines, and natural skin texture visible - NOT airbrushed or plastic. ' +
    '8K resolution, magazine cover quality. ' +
    'NEGATIVE PROMPT: ' + enriched.negativePrompt + ', model must be wearing the CORRECT product, ' +
    'do NOT change garment type or color, no plastic skin, no over-retouched, no anime, not illustration, 100% photorealistic.';

  // === 场景图：生活方式摄影，温暖自然光 ===
  prompts['scene'] =
    'CINEMATIC lifestyle fashion photography of a stylish young East Asian man (age 25-30) wearing ' + vDesc + '. ' +
    'LOCATION: Cozy modern apartment interior with tall windows, natural wood furniture, warm ambient lighting. ' +
    'CAMERA: Leica M11 with 35mm Summilux lens. FULL FRAME SENSOR for natural perspective. ' +
    'LIGHTING: Natural golden hour sunlight streaming through large windows, creating warm rim lighting on subject. ' +
    'Ambient indoor lighting balanced with sunlight for natural color temperature (5600K + 3200K mix). ' +
    'CAMERA SETTINGS: f/2.8 for shallow depth of field, 1/1000s, ISO 400, candid relaxed pose. ' +
    'COMPOSITION: Rule of thirds, subject razor-sharp, background softly blurred (bokeh). ' +
    'THE ' + (productName || 'garment') + ' is the main focus, correctly colored and styled as: ' + vDesc + '. ' +
    'MOOD: Aspirational, warm, inviting, editorial composition. ' +
    'COLOR GRADING: Warm golden hour tones, teal-orange color grade popular in high-end fashion photography. ' +
    '8K resolution, hyper-realistic. ' +
    'NEGATIVE PROMPT: ' + enriched.negativePrompt + ', product must be clearly visible and identifiable, ' +
    'no anime, not illustration, no cartoon, 100% real photography.';

  // === 卖点图：扁平摆放，商业级静物摄影 ===
  prompts['infographic'] =
    'ARCHITECTURAL DIGEST-STYLE flat-lay product photography of ' + vDesc + '. ' +
    'CAMERA: Camera directly overhead at exactly 90 degrees. ' +
    'LIGHTING: Large north-facing window natural light plus two large softboxes for even illumination. ' +
    'No harsh shadows, no hot spots. ' +
    'SURFACE: Pure white seamless paper backdrop. ' +
    'COMPOSITION: Product arranged artfully off-center following rule of thirds. ' +
    '1-2 minimal props MAXIMUM (a single dried flower stem OR a ceramic coffee cup), placed to enhance not distract. ' +
    'Subtle natural shadow beneath product (not cut out, not floating). ' +
    'CAMERA SETTINGS: f/8 for sharpness throughout, ISO 100, tripod-mounted. ' +
    'PRODUCT DETAILS: Texture, color, and design features clearly visible from above. ' +
    'Pinterest-perfect flat lay, 8K crisp resolution, commercial e-commerce thumbnail style. ' +
    'NEGATIVE PROMPT: ' + enriched.negativePrompt + ', no hands, no cluttered props, no cartoon, not anime, 100% photorealistic.';

  // === 尺寸图：测量示意图 ===
  prompts['sizechart'] =
    'Professional clothing size chart infographic for ' + vDesc + '. ' +
    'Clean organized layout on pure white background. ' +
    'Central area: simple clean line drawing of the garment with measurement dimension lines pointing to: waist, length, hip, inseam. ' +
    'Clear numeric size labels (S/M/L/XL) in elegant sans-serif font. ' +
    'Thin clean black lines (1px), professional technical illustration style. ' +
    'This is an INFOGRAPHIC/DIAGRAM, not a photograph. ' +
    'NEGATIVE PROMPT: NO photograph of actual garment, must be a clean measurement diagram with lines and numbers, no cartoon.';

  // === 详情页：电影级英雄图 ===
  prompts['detail'] =
    'CINEMATIC hero image for e-commerce detail page, featuring ' + vDesc + '. ' +
    'Rich atmospheric setting: upscale boutique interior OR scenic outdoor terrace at golden hour. ' +
    'CAMERA: Phase One IQ4 with 110mm lens for flattering compression. ' +
    'LIGHTING: Warm dramatic lighting with chiaroscuro contrast, volumetric light rays (god rays). ' +
    'Rim light separating subject from background. ' +
    'CAMERA SETTINGS: f/4 for subject sharp with dreamy bokeh background, 1/250s, ISO 100. ' +
    'The product is the undeniable hero of the image, glowing with warm highlight, rule-of-thirds placement. ' +
    'Shallow depth of field, dreamy bokeh background, ultra-premium brand aesthetic. ' +
    'Emotional luxury storytelling, makes viewer want to own this product immediately. ' +
    'Vogue/GQ magazine cover quality, 8K, perfect color grading (teal-orange). ' +
    'NEGATIVE PROMPT: ' + enriched.negativePrompt + ', product must be the hero, no amateur snapshot look, ' +
    'no cartoon, not anime, 100% photorealistic, luxury photography.';

  // === 搭配对比图：两种穿搭 ===
  prompts['collocation'] =
    'High-end fashion styling split-composition showing ' + vDesc + ' styled TWO different ways. ' +
    'Two panels side-by-side OR two models: ' +
    'Look 1 (casual): ' + vDesc + ' with basic tee and clean white sneakers. ' +
    'Look 2 (smart): ' + vDesc + ' with button-up shirt, knit sweater over shoulders, and leather Chelsea boots. ' +
    'CAMERA: Hasselblad for incredible detail. ' +
    'LIGHTING: Clean professional studio lighting, even and flattering. ' +
    'Background: Light gray seamless paper. ' +
    'The SAME base garment appears in both looks with IDENTICAL color and style. ' +
    'Professional fashion lookbook photography, GQ/Esquire editorial style, 8K. ' +
    'NEGATIVE PROMPT: both looks MUST contain the SAME base product, do NOT substitute with different items, ' +
    'no cartoon, not anime, 100% photorealistic.';

  return prompts[type] || prompts['whitebg'];
}

// ===== 查询 SiliconFlow 账户余额 =====
function queryBalance(apiKey) {
  return new Promise(function(resolve) {
    var options = {
      hostname: 'api.siliconflow.cn',
      port: 443,
      path: '/v1/user/info',
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    };

    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var json = JSON.parse(data);
          if (json.data && json.data.balance !== undefined) {
            resolve({ success: true, balance: json.data.balance });
          } else {
            resolve({ success: false, error: 'Failed to parse balance' });
          }
        } catch(e) {
          resolve({ success: false, error: e.message });
        }
      });
    });

    req.on('error', function(e) { resolve({ success: false, error: e.message }); });
    req.end();
  });
}

// ===== 通用 OpenAI 兼容图像生成（支持 img2img）=====

function generateWithEngine(engineName, prompt, options) {
  options = options || {};
  var engine = ENGINE_CONFIG[engineName];
  if (!engine || !engine.enabled) return Promise.resolve({ success: false, error: 'Engine not available: ' + engineName });
  if (!engine.apiKey) return Promise.resolve({ success: false, error: engine.label + ' API Key not configured' });

  // ✅ 关键：如果使用付费模型，切换到 paidModel
  var model = options.model || engine.model;
  if (engineName === 'siliconflow' && ENGINE_CONFIG.siliconflow.usePaidModel && engine.paidModel) {
    model = engine.paidModel;
    console.log('[Generate] Using PAID model:', model);
  }

  var imageSize = options.imageSize || '1024x1024';
  var refImage = options.refImage || null; // base64 image for img2img

  var isCogView = (engineName === 'cogview');
  var postData;
  if (isCogView) {
    postData = JSON.stringify({ model: engine.model, prompt: prompt, size: imageSize });
  } else {
    // Kolors 需要 negative_prompt 参数
    var negMatch = prompt.match(/NEGATIVE PROMPT:\s*(.+?)\s*(,?\s*NO|$)/i);
    var mainPrompt = prompt;
    var negativePrompt = '';
    if (negMatch) {
      mainPrompt = prompt.substring(0, prompt.indexOf('NEGATIVE PROMPT:'));
      negativePrompt = negMatch[1];
    }

    var requestBody = {
      model: model,
      prompt: mainPrompt.trim(),
      negative_prompt: negativePrompt,
      image_size: imageSize,
      num_inference_steps: 30, // 增加步数提高质量
      guidance_scale: 8.0, // 提高 Guidance Scale 让图片更贴近 Prompt
      n: 1
    };

    // ✅ 关键：如果有参考图，添加到请求体（img2img）
    if (refImage) {
      requestBody.image = refImage;
      console.log('[Generate] Using img2img, image provided (base64 length: ' + refImage.length + ')');
    }

    postData = JSON.stringify(requestBody);
  }

  var apiUrl = engine.baseUrl + '/images/generations';
  var urlObj;
  try { urlObj = new URL(apiUrl); } catch(err) { return Promise.resolve({ success: false, error: 'Invalid API URL' }); }

  return new Promise(function(resolve) {
    var reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + engine.apiKey,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 120000
    };

    var startTime = Date.now();
    var tag = engine.label.toUpperCase().slice(0, 6);

    var req = https.request(reqOptions, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        try {
          var json = JSON.parse(data);
          var imageUrl = null;

          if (json.images && json.images[0] && json.images[0].url) imageUrl = json.images[0].url;
          else if (json.data && json.data[0] && json.data[0].url) imageUrl = json.data[0].url;
          else if (json.data && json.data[0] && json.data[0].b64_json) {
            resolve({ success: true, base64: json.data[0].b64_json, elapsed: elapsed, engine: engineName });
            return;
          }

          if (imageUrl) {
            console.log('[' + tag + '] OK ' + elapsed + 's');
            resolve({ success: true, url: imageUrl, elapsed: elapsed, engine: engineName });
          } else if (json.error) {
            var errMsg = typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error));
            console.error('[' + tag + '] FAIL ' + elapsed + 's:', errMsg.substring(0, 100));
            resolve({ success: false, error: errMsg, engine: engineName });
          } else {
            console.error('[' + tag + '] FAIL Unknown ' + elapsed + 's:', data.substring(0, 150));
            resolve({ success: false, error: 'Unknown response', engine: engineName });
          }
        } catch(e) {
          console.error('[' + tag + '] PARSE ERROR ' + elapsed + 's:', data.substring(0, 150));
          resolve({ success: false, error: 'Response parse failed', engine: engineName });
        }
      });
    });

    req.on('error', function(e) {
      console.error('[' + tag + '] NETWORK ERROR:', e.message);
      resolve({ success: false, error: e.message, engine: engineName });
    });

    req.on('timeout', function() {
      req.destroy();
      resolve({ success: false, error: 'Timeout (120s)', engine: engineName });
    });

    req.write(postData);
    req.end();
  });
}

// ===== 智能引擎选择 =====

async function smartGenerate(prompt, options) {
  var engineOrder = [ENGINE_CONFIG.active];
  ['siliconflow', 'agnes', 'cogview'].forEach(function(e) {
    if (e !== ENGINE_CONFIG.active && ENGINE_CONFIG[e].enabled && ENGINE_CONFIG[e].apiKey) {
      engineOrder.push(e);
    }
  });

  var lastError = null;
  for (var i = 0; i < engineOrder.length; i++) {
    var eng = engineOrder[i];
    console.log('[SmartGen] Trying: ' + eng + ' (' + (i+1) + '/' + engineOrder.length + ')');
    var result = await generateWithEngine(eng, prompt, options);
    if (result.success) {
      console.log('[SmartGen] SUCCESS via ' + result.engine);
      return result;
    }
    lastError = '[' + ENGINE_CONFIG[eng].label + '] ' + result.error;
  }
  return { success: false, error: 'All engines failed. ' + lastError };
}

// ===== 下载图片 =====

function downloadImage(url, filename) {
  return new Promise(function(resolve) {
    var filepath = path.join(GENERATED_DIR, filename);
    var file = fs.createWriteStream(filepath);
    var proto = url.indexOf('https') === 0 ? https : require('http');
    var getReq = proto.get(url, { timeout: 30000 }, function(response) {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadImage(response.headers.location, filename).then(resolve);
        return;
      }
      if (response.statusCode !== 200) {
        resolve({ success: false, error: 'HTTP ' + response.statusCode });
        return;
      }
      response.pipe(file);
      file.on('finish', function() {
        file.close();
        var sizeKB = (fs.statSync(filepath).size / 1024).toFixed(1);
        console.log('[DL] OK ' + filename + ' (' + sizeKB + 'KB)');
        resolve({ success: true, filename: filename, filepath: '/generated-images/' + filename, sizeKB: sizeKB });
      });
      file.on('error', function(err) {
        fs.unlink(filepath, function() {});
        resolve({ success: false, error: err.message });
      });
    });
    getReq.on('error', function(err) { resolve({ success: false, error: err.message }); });
  });
}

function saveBase64Image(base64Data, filename) {
  var filepath = path.join(GENERATED_DIR, filename);
  var matches = String(base64Data).match(/^data:image\/(\w+);base64,(.+)$/);
  var buffer = matches ? Buffer.from(matches[2], 'base64') : Buffer.from(String(base64Data), 'base64');
  fs.writeFileSync(filepath, buffer);
  var sizeKB = (buffer.length / 1024).toFixed(1);
  console.log('[SAVE] OK ' + filename + ' (' + sizeKB + 'KB)');
  return { success: true, filename: filename, filepath: '/generated-images/' + filename, sizeKB: sizeKB };
}

// ===== 任务队列管理 =====

function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch(e) { console.error('Error loading tasks:', e.message); }
  return { pending: [], completed: [], failed: [] };
}

function saveTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function findTask(tasks, taskId) {
  return (tasks.pending || []).find(function(t) { return t.id === taskId; }) ||
         (tasks.completed || []).find(function(t) { return t.id === taskId; }) ||
         (tasks.failed || []).find(function(t) { return t.id === taskId; }) || null;
}

function updateTaskProgress(taskId, type, filename, totalTypes) {
  var tasks = loadTasks();
  var task = findTask(tasks, taskId);
  if (!task) return;
  if (!task.results) task.results = {};
  task.results[type] = filename;
  task.errors = task.errors || {};
  task.errors[type] = null;
  if (Object.keys(task.results).length >= totalTypes) {
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    tasks.completed.unshift(task);
    task.pending = (task.pending || []).filter(function(t) { return t.id !== taskId; });
    console.log('[Task ' + taskId + '] ALL DONE (' + totalTypes + ' images)');
  }
  saveTasks(tasks);
}

function recordTaskError(taskId, type, errorMessage, totalTypes) {
  var tasks = loadTasks();
  var task = findTask(tasks, taskId);
  if (!task) return;
  task.errors = task.errors || {};
  task.errors[type] = errorMessage;
  var doneCount = Object.keys(task.results || {}).length;
  var errorCount = Object.keys(task.errors || {}).filter(function(k) { return task.errors[k]; }).length;
  if (doneCount + errorCount >= totalTypes) {
    if (doneCount > 0) { task.status = 'completed'; task.partialSuccess = true; }
    else { task.status = 'failed'; task.error = 'All failed'; }
    tasks.completed.unshift(task);
    task.pending = (task.pending || []).filter(function(t) { return t.id !== taskId; });
  }
  saveTasks(tasks);
}

// ===== API 路由 =====

app.post('/api/generate', async function(req, res) {
  try {
    var productName = req.body.productName;
    var sellingPoints = req.body.sellingPoints || '';
    var types = req.body.types || ['whitebg'];
    var refDescription = req.body.refDescription || '';
    var refImage = req.body.refImage || null; // ✅ 新增：接收参考图（base64）

    if (!productName) return res.status(400).json({ error: 'Product name required' });

    var taskId = randomUUID().slice(0, 8);
    var enriched = enrichProductDescription(productName, sellingPoints);

    console.log('[Task ' + taskId + '] 产品: ' + productName);
    console.log('[Task ' + taskId + '] 视觉描述: ' + enriched.visualDesc);
    console.log('[Task ' + taskId + '] 类型: [' + types.join(',') + ']');
    if (refImage) {
      console.log('[Task ' + taskId + '] 参考图: 已提供 (base64 length: ' + refImage.length + ')');
    }

    var task = {
      id: taskId,
      productName: productName,
      sellingPoints: sellingPoints,
      types: types,
      refDescription: refDescription,
      refImage: refImage, // ✅ 保存参考图到任务
      status: 'processing',
      engine: 'multi-engine',
      createdAt: new Date().toISOString(),
      results: {},
      errors: {}
    };

    var tasks = loadTasks();
    tasks.pending.push(task);
    saveTasks(tasks);

    // ✅ 传递 refImage 给生成函数
    runMultiEngineGeneration(taskId, types, productName, sellingPoints, refDescription, refImage);

    res.json({ taskId: taskId, status: 'processing', engine: 'multi-engine', totalImages: types.length });
  } catch(err) {
    console.error('/api/generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

async function runMultiEngineGeneration(taskId, types, productName, sellingPoints, refDescription, refImage) {
  for (var ti = 0; ti < types.length; ti++) {
    var type = types[ti];
    try {
      console.log('[Task ' + taskId + '] [' + type + '] 生成中... (' + (ti+1) + '/' + types.length + ')');
      var prompt = buildPrompt(type, productName, sellingPoints, refDescription);
      console.log('[Task ' + taskId + '] [' + type + '] Prompt前150字: ' + prompt.substring(0, 150));

      // ✅ 传递 refImage 给 smartGenerate
      var result = await smartGenerate(prompt, { refImage: refImage });
      if (!result.success) throw new Error(result.error || 'All engines failed');

      var filename = type + '-' + taskId + '-' + Date.now() + '.png';
      var dlResult;
      if (result.base64) {
        dlResult = saveBase64Image(result.base64, filename);
      } else {
        dlResult = await downloadImage(result.url, filename);
      }
      if (!dlResult.success) throw new Error('Save failed: ' + dlResult.error);

      updateTaskProgress(taskId, type, filename, types.length);
    } catch(err) {
      console.error('[Task ' + taskId + '] [' + type + '] 失败:', err.message);
      recordTaskError(taskId, type, err.message, types.length);
    }
  }
}

// 状态查询
app.get('/api/status/:taskId', function(req, res) {
  var taskId = req.params.taskId;
  var tasks = loadTasks();
  var task = findTask(tasks, taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  var response = {
    taskId: task.id,
    status: task.status,
    engine: task.engine || 'multi-engine',
    createdAt: task.createdAt,
    totalTypes: task.types ? task.types.length : 0,
    doneTypes: Object.keys(task.results || {}).length,
    errorTypes: Object.keys(task.errors || {}).filter(function(k) { return task.errors[k]; }).length
  };

  if (task.status === 'completed') {
    response.results = {};
    response.message = task.partialSuccess ? 'Partial completion' : 'All done!';
    for (var key in task.results) {
      if (task.results.hasOwnProperty(key)) {
        response.results[key] = '/generated-images/' + task.results[key];
      }
    }
  } else if (task.status === 'failed') {
    response.error = task.error || 'Generation failed';
    response.errors = task.errors || {};
  } else {
    response.message = 'Generating... (' + Object.keys(task.results||{}).length + '/' + (task.types||[]).length + ')';
  }
  res.json(response);
});

// 引擎配置
app.get('/api/engine-status', function(req, res) {
  res.json({
    active: ENGINE_CONFIG.active,
    usePaidModel: ENGINE_CONFIG.siliconflow.usePaidModel,
    engines: {
      siliconflow: { enabled: ENGINE_CONFIG.siliconflow.enabled, hasKey: !!ENGINE_CONFIG.siliconflow.apiKey, model: ENGINE_CONFIG.siliconflow.model, paidModel: ENGINE_CONFIG.siliconflow.paidModel, label: ENGINE_CONFIG.siliconflow.label },
      agnes: { enabled: ENGINE_CONFIG.agnes.enabled, hasKey: !!ENGINE_CONFIG.agnes.apiKey, model: ENGINE_CONFIG.agnes.model, label: ENGINE_CONFIG.agnes.label },
      cogview: { enabled: ENGINE_CONFIG.cogview.enabled, hasKey: !!ENGINE_CONFIG.cogview.apiKey, model: ENGINE_CONFIG.cogview.model, label: ENGINE_CONFIG.cogview.label }
    }
  });
});

// ✅ 新增：查询账户余额
app.get('/api/balance', async function(req, res) {
  var apiKey = ENGINE_CONFIG.siliconflow.apiKey;
  if (!apiKey) return res.status(400).json({ error: 'SiliconFlow API Key not configured' });

  var result = await queryBalance(apiKey);
  if (result.success) {
    res.json({ success: true, balance: result.balance });
  } else {
    res.status(500).json({ error: result.error });
  }
});

// ✅ 新增：切换免费/付费模型
app.post('/api/toggle-paid-model', function(req, res) {
  try {
    var usePaid = req.body.usePaidModel;
    ENGINE_CONFIG.siliconflow.usePaidModel = usePaid;

    // 保存到配置文件
    var saved = JSON.parse(fs.readFileSync(ENGINE_CONFIG_FILE, 'utf8'));
    if (!saved.siliconflow) saved.siliconflow = {};
    saved.siliconflow.usePaidModel = usePaid;
    fs.writeFileSync(ENGINE_CONFIG_FILE, JSON.stringify(saved, null, 2));

    console.log('[Config] Paid model:', usePaid ? 'ENABLED (Z-Image-Turbo)' : 'DISABLED (Kolors)');
    res.json({ success: true, usePaidModel: usePaid });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/engine-config', function(req, res) {
  try {
    var engine = req.body.engine || 'siliconflow';
    if (req.body.apiKey) ENGINE_CONFIG[engine].apiKey = req.body.apiKey;
    if (req.body.model) ENGINE_CONFIG[engine].model = req.body.model;
    if (req.body.active) ENGINE_CONFIG.active = req.body.active;

    fs.writeFileSync(ENGINE_CONFIG_FILE, JSON.stringify({
      siliconflow: { apiKey: ENGINE_CONFIG.siliconflow.apiKey, model: ENGINE_CONFIG.siliconflow.model },
      agnes: { apiKey: ENGINE_CONFIG.agnes.apiKey, model: ENGINE_CONFIG.agnes.model },
      cogview: { apiKey: ENGINE_CONFIG.cogview.apiKey, model: ENGINE_CONFIG.cogview.model, enabled: ENGINE_CONFIG.cogview.enabled },
      active: ENGINE_CONFIG.active
    }, null, 2));

    console.log('[Config] 已更新: active=' + ENGINE_CONFIG.active);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// 图片上传
app.post('/api/upload-result', function(req, res) {
  try {
    var image = req.body.image;
    if (!image) return res.status(400).json({ error: 'No image' });
    var base64Data = String(image).replace(/^data:image\/\w+;base64,/, '');
    var buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length < 1000) return res.status(400).json({ error: 'Image too small' });
    var filename = 'upload-' + Date.now() + '.png';
    fs.writeFileSync(path.join(GENERATED_DIR, filename), buffer);
    res.json({ success: true, filename: filename, filepath: '/generated-images/' + filename });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// 静态图片服务
app.get('/generated-images/:filename', function(req, res) {
  var filename = req.params.filename.replace(/[/\\]/g, '');
  var filePath = path.join(GENERATED_DIR, filename);
  if (fs.existsSync(filePath) && filePath.startsWith(GENERATED_DIR)) {
    res.sendFile(filePath);
  } else { res.status(404).send('Not found'); }
});

// 调试接口：查看prompt enrichment效果
app.post('/api/debug-enrich', function(req, res) {
  var productName = req.body.productName || '';
  var sellingPoints = req.body.sellingPoints || '';
  var enriched = enrichProductDescription(productName, sellingPoints);
  var samplePrompt = buildPrompt('whitebg', productName, sellingPoints, '');
  res.json({
    input: { productName: productName, sellingPoints: sellingPoints },
    enriched: enriched,
    sampleWhitebgPrompt: samplePrompt.substring(0, 600)
  });
});

// ===== 启动服务器 =====
app.listen(PORT, function() {
  console.log('');
  console.log('+------------------------------------------------------------+');
  console.log('|       AI DesignKit Server v14 - Img2Img + Top Photographer |');
  console.log('|       http://localhost:' + PORT + '                              |');
  console.log('+------------------------------------------------------------+');
  console.log('|  ✅ Img2Img 支持: 前端上传参考图 → 后端 img2img 生成       |');
  console.log('|  ✅ 顶级摄影师 Prompt: Phase One IQ4, Hasselblad, Leica   |');
  console.log('|  ✅ 负面提示词优化: 避免动漫/插画/3D渲染                |');
  console.log('+------------------------------------------------------------+');
  console.log('');
});
