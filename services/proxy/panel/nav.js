function dwTop(){ return dwStack.length ? dwStack[dwStack.length-1] : null; }
function dwPush(v){ dwStack.push(v); dwDir='push'; dwRender(); }
function dwPop(){ dwStack.pop(); dwDir='dwPop'; dwRender(); }