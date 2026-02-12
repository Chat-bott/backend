const { GoogleGenerativeAI } = require('@google/generative-ai');

require('dotenv').config();

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('Gemini API key is not configured. Please set GEMINI_API_KEY in your .env file');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

const getModel = () => {
  try {
    return genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  } catch (error) {
    console.warn('gemini-2.5-flash not available, using gemini-pro');
    return genAI.getGenerativeModel({ model: 'gemini-pro' });
  }
};

const processMessage = async (userMessage, conversationHistory = [], pageContent = null) => {
  try {
    const model = getModel();
    
    const systemPrompt = `You are a helpful co-browsing assistant for a portfolio website. 
You can help users explore the website by answering questions and performing actions.

${pageContent ? `
Current page structure:
- Sections: ${pageContent.sections?.map(s => s.id).join(', ') || 'N/A'}
- Projects: ${pageContent.projects?.length || 0} projects available
- Contact form available

${pageContent.projects ? `
AVAILABLE PROJECTS:
${pageContent.projects.map(p => 
  `- ${p.title} (${p.date}): ${p.description.substring(0, 100)}...`
).join('\n')}
` : ''}

${pageContent.sections ? `
AVAILABLE SECTIONS:
${pageContent.sections.map(s => 
  `- ${s.id}: ${s.title || s.id.charAt(0).toUpperCase() + s.id.slice(1)}`
).join('\n')}
` : ''}
` : ''}

Available actions you can perform:
1. scroll_to_section - Navigate to different sections
2. scroll_page - Scroll up or down
3. highlight_element - Highlight elements on the page
4. click_element - Click buttons or links
5. fill_input - Fill form inputs
6. get_page_content - Get detailed page information

When users ask questions about the content, use get_page_content first to understand what's available.
When users want to navigate or interact, use the appropriate action functions.

Be conversational, helpful, and proactive. If a user asks about projects, highlight them or scroll to the projects section.
If they want to contact, help them fill the form or navigate to the contact section.

AVAILABLE ACTIONS (use these patterns in your response when user requests actions):
- Scroll to section: [ACTION:scroll_to_section:sectionId] (sectionId can be: home, about, projects, contact)
- Highlight element by text: [ACTION:highlight:text] (e.g., project title, section name)
- Click element by text: [ACTION:click:text] (e.g., button text, link text)
- Fill form input: [ACTION:fill:selector:value] (selector: #name, #email, #message)

INSTRUCTIONS:
1. Answer questions naturally and conversationally
2. When user asks to navigate, highlight, or interact, include the appropriate ACTION tag
3. For questions about content, provide detailed answers based on the information above
4. Be proactive - if user asks about projects, consider highlighting or scrolling to projects section

User message: "${userMessage}"

Respond naturally, and if an action is needed, include the ACTION tag.`;

    let history = [];
    if (conversationHistory.length > 0) {
      const recentHistory = conversationHistory.slice(-6);
      
      const geminiHistory = recentHistory.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      }));
      
      let startIndex = 0;
      while (startIndex < geminiHistory.length && geminiHistory[startIndex].role === 'model') {
        startIndex++;
      }
      
      history = geminiHistory.slice(startIndex);
      
      const cleanedHistory = [];
      for (let i = 0; i < history.length; i++) {
        const current = history[i];
        const previous = cleanedHistory[cleanedHistory.length - 1];
        if (!previous || previous.role !== current.role) {
          cleanedHistory.push(current);
        }
      }
      
      history = cleanedHistory;
    }

    const chat = model.startChat({
      history: history
    });

    const result = await chat.sendMessage(systemPrompt);
    const response = await result.response;
    let responseText = response.text();

    const actionResults = [];
    const actionPatterns = [
      /\[ACTION:scroll_to_section:(\w+)\]/g,
      /\[ACTION:highlight:(.+?)\]/g,
      /\[ACTION:click:(.+?)\]/g,
      /\[ACTION:fill:([^:]+):(.+?)\]/g
    ];

    responseText = responseText.replace(/\[ACTION:[^\]]+\]/g, '');
    
    let match;
    while ((match = actionPatterns[0].exec(responseText)) !== null) {
      actionResults.push({
        type: 'scroll_to_section',
        data: { sectionId: match[1] }
      });
    }

    while ((match = actionPatterns[1].exec(responseText)) !== null) {
      actionResults.push({
        type: 'highlight',
        data: { text: match[1].trim() }
      });
    }

    while ((match = actionPatterns[2].exec(responseText)) !== null) {
      actionResults.push({
        type: 'click',
        data: { text: match[1].trim() }
      });
    }

    while ((match = actionPatterns[3].exec(responseText)) !== null) {
      actionResults.push({
        type: 'fill',
        data: { selector: match[1].trim(), value: match[2].trim() }
      });
    }

    return {
      text: responseText.trim(),
      actions: actionResults
    };
  } catch (error) {
    console.error('Gemini API Error:', error);
    let errorMessage = 'I apologize, but I encountered an error. ';
    
    if (error.message?.includes('API_KEY')) {
      errorMessage += 'API key configuration issue.';
    } else if (error.message?.includes('quota') || error.message?.includes('429')) {
      errorMessage += 'API quota exceeded. Please try again later.';
    } else if (error.message?.includes('403') || error.message?.includes('permission')) {
      errorMessage += 'API access denied. Please verify API permissions.';
    } else if (error.message?.includes('network') || error.message?.includes('fetch')) {
      errorMessage += 'Network error. Please check your internet connection.';
    } else {
      errorMessage += `Error details: ${error.message || 'Unknown error'}.`;
    }
    
    return {
      text: errorMessage,
      actions: []
    };
  }
};

module.exports = {
  processMessage
};
