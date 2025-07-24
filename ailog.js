// ==UserScript==
// @name         log-ai-summary
// @namespace    http://tampermonkey.net/
// @version      3.6.1
// @description  log-ai-summary
// @author       clicker
// @match        http://portal.example.internal.com/behavior/onextrace*
// @match        http://portal.example.prod.com/behavior/onextrace*
// @grant        unsafeWindow
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_abort
// @grant        GM_getValue
// @require      https://cdn.jsdelivr.net/npm/marked/marked.min.js
// @connect      proxy.api.example.com
// @updateURL    https://git.example.com/user/project/-/raw/main/meta.js
// @downloadURL  https://git.example.com/user/project/-/raw/main/main.js
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // AI配置
    const AI_CONFIG = {
        internal: {
            apiKey: GM_getValue("apiKey", ""),
            endpoint: GM_getValue("endpoint", ""),
            model: GM_getValue("model", ""),
            enable_thinking: GM_getValue("enable_thinking", false)
        }
    };

    // 环境配置
    let detailUrl, searchUrl;
    if (window.location.hostname === 'portal.example.prod.com') {
        // 生产环境
        detailUrl = '/api/trace/detail';
        searchUrl = '/api/trace/search';
    } else {
        // 测试环境
        detailUrl = '/api/trace/detail';
        searchUrl = '/api/trace/search';
    }

    const capturedLogs = {};
    unsafeWindow.capturedLogs = capturedLogs;
    const guidToProductTypeMap = {};
    unsafeWindow.guidToProductTypeMap = guidToProductTypeMap;

    // 拦截请求
    const originalOpen = unsafeWindow.XMLHttpRequest.prototype.open;
    const originalSend = unsafeWindow.XMLHttpRequest.prototype.send;

    unsafeWindow.XMLHttpRequest.prototype.open = function(method, url) {
        this._requestURL = url;
        return originalOpen.apply(this, arguments);
    };

    unsafeWindow.XMLHttpRequest.prototype.send = function(data) {
        if (this._requestURL === detailUrl) {
            try {
                const requestBody = JSON.parse(data);
                if (requestBody?.condition?.guid) {
                    const guid = requestBody.condition.guid;
                    this.addEventListener('load', () => {
                        if (this.status === 200) {
                            capturedLogs[guid] = this.responseText;
                        }
                    });
                }
            } catch (e) {
                console.error('解析请求体 JSON 失败:', e);
            }
        } else if (this._requestURL === searchUrl) {
            this.addEventListener('load', () => {
                if (this.status === 200) {
                    try {
                        const responseData = JSON.parse(this.responseText);
                        if (responseData?.data && Array.isArray(responseData.data)) {
                            responseData.data.forEach(item => {
                                if (item.idInfo?.guid && item.layers?.ProductType) {
                                    guidToProductTypeMap[item.idInfo.guid] = item.layers.ProductType;
                                }
                            });
                        }
                    } catch (e) {
                        console.error('解析响应体 JSON 失败:', e);
                    }
                }
            });
        }
        return originalSend.apply(this, arguments);
    };

    // 工具函数
    function debounce(func, delay) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), delay);
        };
    }

    // 侧边栏定位
    function adjustPanelPosition() {
        const contentWrapper = document.querySelector('.content-wrapper.ivu-layout-content');
        const panel = document.getElementById('ai-summary-panel');
        if (!panel) {
            return;
        }

        if (contentWrapper) {
            const rect = contentWrapper.getBoundingClientRect();
            panel.style.top = `${rect.top}px`;
            panel.style.height = `${rect.height}px`;
        } else {
            console.warn('未找到目标布局元素，使用默认定位');
            panel.style.top = '64px';
            panel.style.height = 'calc(100vh - 64px)';
        }
    }

    // AI API调用（流式）
    function callInternalAPI(prompt, onChunk, onComplete, onError) {
        const internalConfig = AI_CONFIG.internal;
        if (!internalConfig || !internalConfig.apiKey || !internalConfig.endpoint || !internalConfig.model) {
            onError(new Error("请在 AI_CONFIG.internal 中配置 apiKey, endpoint 和 model"));
            return;
        }

        const apiUrl = `${internalConfig.endpoint}/v1/chat/completions`;
        const payload = {
            model: internalConfig.model,
            messages: [{
                role: "system",
                content: "你是专业的系统架构师和问题排查专家，擅长分析分布式系统调用链日志。"
            }, {
                role: "user",
                content: prompt
            }],
            temperature: 0.7,
            top_p: 0.8,
            frequency_penalty: 0,
            stream: true,
            chat_template_kwargs: {
                "enable_thinking": AI_CONFIG.internal.enable_thinking
            }
        };

        let buffer = '';
        let lastSeen = 0;
        const req = GM_xmlhttpRequest({
            method: 'POST',
            url: apiUrl,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${internalConfig.apiKey}`
            },
            data: JSON.stringify(payload),
            onprogress: function(response) {
                const newText = response.responseText.substring(lastSeen);
                lastSeen = response.responseText.length;
                buffer += newText;
                let boundary;
                while ((boundary = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, boundary).trim();
                    buffer = buffer.substring(boundary + 1);

                    if (line.startsWith('data: ')) {
                        const jsonStr = line.substring(6);
                        if (jsonStr === '[DONE]') {
                            onComplete();
                            req.abort();
                            return;
                        }
                        try {
                            const data = JSON.parse(jsonStr);
                            const content = data.choices?.[0]?.delta?.content;
                            if (content) {
                                onChunk(content);
                            }
                        } catch (e) {
                            onError(new Error(`解析流式数据失败: ${e.message}\n原始数据: "${jsonStr}"`));
                            req.abort();
                            return;
                        }
                    }
                }
            },
            onload: onComplete,
            onerror: (err) => onError(new Error(`网络请求错误: ${JSON.stringify(err)}`)),
            ontimeout: () => onError(new Error("请求超时"))
        });
    }

    // Prompt生成
    function tryFormatJson(jsonString) {
        if (!jsonString) {
            return '无';
        }
        try {
            return JSON.stringify(JSON.parse(jsonString), null, 2);
        } catch (e) {
            return jsonString;
        }
    }

    function isSuccessful(log) {
        if (log.result === 0) {
            return true;
        }
        try {
            const res = JSON.parse(log.response);
            if (res?.ResponseStatus?.Ack === 'Success') {
                return true;
            }
            if (res && (res.Code === 0 || res.code === 0) && (res.IsSuccessful === true || res.isSuccessful === true || res.msg === "Success")) {
                return true;
            }
        } catch (e) {
            // 忽略解析错误
        }
        return false;
    }

    function generateLLMPrompt(responseString, productTypes) {
        try {
            const fullResponse = JSON.parse(responseString);
            let logs = fullResponse.data;

            if (!logs || !Array.isArray(logs) || logs.length === 0) {
                return "无法生成 Prompt: 响应数据为空或格式不正确";
            }

            logs.sort((a, b) => new Date(a.requestTime || a.logTime) - new Date(b.requestTime || b.logTime));

            let logDetails = logs.map((log, index) => `
**[第 ${index + 1} 步]: ${log.appName || '未知服务'} - ${log.operation || '未知操作'}**

* **服务名称:** ${log.appName} (${log.appId || 'N/A'})
* **日志类型:** ${log.logType || '未知'}
* **请求时间:** ${log.requestTime || log.logTime}
* **耗时:** ${log.intervals || 'N/A'}ms
* **结果:** ${isSuccessful(log) ? '成功' : '失败/未知'}

**请求体:**
\`\`\`json
${tryFormatJson(log.request)}
\`\`\`

**响应体:**
\`\`\`json
${tryFormatJson(log.response)}
\`\`\`
---`).join('');

            let focusPrompt = '';
            if (productTypes && productTypes.length > 0) {
                const typesString = productTypes.map(p => `"${p}"`).join('、');
                focusPrompt = `，重点关注 ${typesString} 相关部分`;
            }

            return `根据以下 TraceLog 日志${focusPrompt}，按格式分析总结：

### **分析报告**

**1. 核心结论**
- 总结请求是否成功/失败
- 如失败，指出根本原因和具体位置
- 如成功，概括业务目标达成情况

**2. 调用链分析**
- 按顺序分析每一步的执行情况、耗时和作用
- 对关键步骤展示核心错误信息或关键字段

### **日志数据**
${logDetails}

请开始分析：`;
        } catch (e) {
            console.error("生成 Prompt 失败:", e);
            return `生成 Prompt 失败: ${e.message}`;
        }
    }

    // DOM操作
    function showProductTypeSelector(productTypes, callback) {
        const overlay = document.createElement('div');
        overlay.className = 'ai-modal-overlay';

        let optionsHTML = `
        <div style="margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 10px;">
            <label class="ai-modal-checkbox-label">
                <input type="checkbox" id="pt-select-all"> <strong>全选 / 全不选</strong>
            </label>
        </div>
    `;

        optionsHTML += productTypes.map((pt, index) => `
        <label for="pt-checkbox-${index}" class="ai-modal-checkbox-label">
            <input type="checkbox" id="pt-checkbox-${index}" class="pt-item-checkbox" name="product-type" value="${pt}">
            ${pt}
        </label>
    `).join('');

        const modalHTML = `
        <div class="ai-modal-content">
            <div class="ai-modal-header">选择要分析的产品类型 (可多选)</div>
            <div class="ai-modal-body">${optionsHTML}</div>
            <div class="ai-modal-footer">
                <button id="ai-modal-cancel" class="ivu-btn">取消</button>
                <button id="ai-modal-confirm" class="ivu-btn ivu-btn-primary" style="margin-left: 8px;">确认</button>
            </div>
        </div>
    `;

        overlay.innerHTML = modalHTML;
        document.body.appendChild(overlay);

        const confirmBtn = document.getElementById('ai-modal-confirm');
        const cancelBtn = document.getElementById('ai-modal-cancel');
        const selectAllCheckbox = document.getElementById('pt-select-all');
        const itemCheckboxes = overlay.querySelectorAll('.pt-item-checkbox');

        function updateButtonState() {
            const anyChecked = Array.from(itemCheckboxes).some(cb => cb.checked);
            confirmBtn.disabled = !anyChecked;
        }

        selectAllCheckbox.addEventListener('change', (e) => {
            itemCheckboxes.forEach(checkbox => {
                checkbox.checked = e.target.checked;
            });
            updateButtonState();
        });

        itemCheckboxes.forEach(checkbox => {
            checkbox.addEventListener('change', () => {
                const allChecked = Array.from(itemCheckboxes).every(cb => cb.checked);
                selectAllCheckbox.checked = allChecked;
                updateButtonState();
            });
        });

        updateButtonState();

        function closeModal() {
            document.body.removeChild(overlay);
        }

        confirmBtn.onclick = () => {
            const selectedTypes = Array.from(overlay.querySelectorAll('.pt-item-checkbox:checked'))
                                       .map(cb => cb.value);
            callback(selectedTypes);
            closeModal();
        };

        cancelBtn.onclick = () => {
            callback(null);
            closeModal();
        };
    }


    function startAnalysis(guid, productTypes) {
        const responseData = unsafeWindow.capturedLogs[guid];
        const panel = document.getElementById('ai-summary-panel');
        const promptOutput = document.getElementById('ai-prompt-output');
        const resultDisplay = document.getElementById('ai-result-display');
        const loader = document.getElementById('ai-panel-loader');

        if (!responseData) {
            alert(`未找到 GUID: ${guid} 对应的数据`);
            return;
        }

        resultDisplay.innerHTML = '';
        loader.style.display = 'block';
        adjustPanelPosition();
        panel.classList.add('visible');

        const promptText = generateLLMPrompt(responseData, productTypes);
        promptOutput.value = promptText;

        let title = `AI 分析结果 (${AI_CONFIG.internal.model})`;
        if (productTypes && productTypes.length > 0) {
            title += ` - ${productTypes.join(', ')}`;
        }
        document.querySelector('.ai-panel-header h2').textContent = title;

        if (promptText.startsWith('无法生成 Prompt')) {
            resultDisplay.textContent = promptText;
            loader.style.display = 'none';
            return;
        }

        let fullResponseText = "";
        let analysisStarted = false;

        callInternalAPI(
            promptText,
            (chunk) => {
                if (!analysisStarted) {
                    loader.style.display = 'none';
                    analysisStarted = true;
                }
                fullResponseText += chunk;
                resultDisplay.innerHTML = marked.parse(fullResponseText);
            },
            () => {
                if (!analysisStarted) {
                    loader.style.display = 'none';
                }
                console.log("AI 分析完成");
            },
            (error) => {
                loader.style.display = 'none';
                resultDisplay.textContent = `AI 分析失败:\n${error.message}`;
            }
        );
    }


    function createSidePanel() {
        if (document.getElementById('ai-summary-panel')) {
            return;
        }
        GM_addStyle(`
            #ai-summary-panel {
                position: fixed;
                right: -460px;
                width: 450px;
                background-color: #ffffff;
                z-index: 9998;
                box-shadow: -2px 0 12px rgba(0,0,0,0.1);
                transition: right 0.4s ease-in-out;
                display: flex;
                flex-direction: column;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            }
            #ai-summary-panel.visible { right: 0; }
            .ai-panel-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 15px;
                border-bottom: 1px solid #eee;
                flex-shrink: 0;
            }
            .ai-panel-header h2 { margin: 0; font-size: 1.1em; font-weight: 600; }
            .ai-panel-close { color: #888; font-size: 24px; font-weight: bold; cursor: pointer; line-height: 1; }
            .ai-panel-close:hover { color: #000; }
            .ai-panel-body { flex-grow: 1; overflow-y: auto; }
            #ai-panel-loader { display: none; text-align: center; padding: 40px 20px; }
            .ai-spinner { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto 15px auto; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .ai-panel-footer { padding: 10px 15px; border-top: 1px solid #eee; flex-shrink: 0; background-color: #fcfcfc; }
            .ai-panel-footer summary { cursor: pointer; color: #555; font-size: 0.9em; }
            #ai-prompt-output {
                width: 100%; height: 150px; font-family: monospace; white-space: pre-wrap;
                word-wrap: break-word; background-color: #f4f4f4; border: 1px solid #ddd;
                border-radius: 4px; padding: 10px; resize: vertical; margin-top: 10px; box-sizing: border-box;
            }
            #ai-result-display { padding: 5px 15px; min-height: 100px; line-height: 1.6; word-wrap: break-word; }
            #ai-result-display h1, #ai-result-display h2, #ai-result-display h3 {
                border-bottom: 1px solid #eee; padding-bottom: 0.3em; margin-top: 24px; margin-bottom: 16px; font-weight: 600;
            }
            #ai-result-display ul, #ai-result-display ol { padding-left: 2em; }
            #ai-result-display code {
                font-family: monospace; background-color: #eee; padding: 0.2em 0.4em;
                border-radius: 3px; font-size: 0.9em;
            }
            #ai-result-display pre {
                background-color: #f4f4f4; border: 1px solid #ddd; border-radius: 4px; padding: 10px;
                white-space: pre-wrap; word-break: break-all;
            }
            #ai-result-display pre code { display: block; padding: 0; background-color: transparent; }
            .ai-modal-overlay {
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.5); z-index: 10000; display: flex;
                align-items: center; justify-content: center;
            }
            .ai-modal-content {
                background: #fff; padding: 20px; border-radius: 8px;
                width: 400px; box-shadow: 0 5px 15px rgba(0,0,0,0.3);
            }
            .ai-modal-header {
                font-size: 1.2em; font-weight: bold; margin-bottom: 15px;
            }
            .ai-modal-body label.ai-modal-checkbox-label {
                display: block; padding: 10px; cursor: pointer;
                border-radius: 4px; border: 1px solid transparent; margin-bottom: 5px;
            }
            .ai-modal-body label.ai-modal-checkbox-label:hover { background-color: #f0f0f0; border-color: #ddd; }
            .ai-modal-body input[type="checkbox"] { margin-right: 10px; vertical-align: middle; }
            .ai-modal-footer {
                text-align: right; margin-top: 20px;
            }
        `);

        const panelHTML = `
            <div id="ai-summary-panel">
                <div class="ai-panel-header">
                    <h2>AI 分析结果</h2>
                    <span class="ai-panel-close">&times;</span>
                </div>
                <div class="ai-panel-body">
                    <div id="ai-panel-loader">
                        <div class="ai-spinner"></div>
                        <p>正在分析中...</p>
                    </div>
                    <div id="ai-result-display"></div>
                </div>
                <div class="ai-panel-footer">
                    <details>
                        <summary>查看发送的 Prompt</summary>
                        <textarea id="ai-prompt-output" readonly></textarea>
                    </details>
                </div>
            </div>`;
        document.body.insertAdjacentHTML('beforeend', panelHTML);

        document.querySelector('#ai-summary-panel .ai-panel-close').onclick = () => {
            document.getElementById('ai-summary-panel').classList.remove('visible');
        };
    }

    function addAiSummaryButton(guidLabel) {
        const subTable = guidLabel.closest('.onex-trace-table-sub');
        if (!subTable) return;

        const parentContainer = subTable.parentElement;
        if (!parentContainer || parentContainer.querySelector('.ai-summary-btn-container')) return;

        const guid = guidLabel.nextElementSibling?.textContent?.trim();
        if (!guid) return;

        const buttonWrapper = document.createElement('div');
        buttonWrapper.className = 'ai-summary-btn-container';
        buttonWrapper.style.cssText = 'margin-bottom: 10px; padding-left: 10px;';

        const summaryButton = document.createElement('button');
        summaryButton.textContent = 'AI 总结 ✨';
        summaryButton.className = 'ivu-btn ivu-btn-primary ai-summary-btn';
        buttonWrapper.appendChild(summaryButton);

        summaryButton.addEventListener('click', () => {
            const productTypeString = unsafeWindow.guidToProductTypeMap[guid];
            if (productTypeString) {
                const productTypes = productTypeString.split(',').map(p => p.trim()).filter(Boolean);
                if (productTypes.length > 1) {
                    showProductTypeSelector(productTypes, (selectedTypes) => {
                        if (selectedTypes !== null) {
                            startAnalysis(guid, selectedTypes);
                        }
                    });
                } else {
                    startAnalysis(guid, productTypes);
                }
            } else {
                startAnalysis(guid, []);
            }
        });
        parentContainer.insertBefore(buttonWrapper, subTable);
    }

    function scanAndAddButtons() {
        document.querySelectorAll('.title-label').forEach(label => {
            if (label.textContent.trim() === 'Guid:') {
                addAiSummaryButton(label);
            }
        });
    }

    // 启动脚本
    const observer = new MutationObserver((mutationsList) => {
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                scanAndAddButtons();
                break;
            }
        }
    });

    window.addEventListener('load', () => {
        createSidePanel();

        // 页面稳定后初始化定位
        setTimeout(() => {
            adjustPanelPosition();
            window.addEventListener('resize', debounce(adjustPanelPosition, 150));
        }, 500);

        scanAndAddButtons();
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    });
})();
