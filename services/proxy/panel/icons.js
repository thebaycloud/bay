var ICONS = {"eye":"<path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>","copy":"<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\"/><path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\"/>","arrow-right":"<path d=\"M5 12h14\"/><path d=\"m12 5 7 7-7 7\"/>","plus":"<path d=\"M5 12h14\"/><path d=\"M12 5v14\"/>","refresh-cw":"<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\"/><path d=\"M21 3v5h-5\"/><path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\"/><path d=\"M8 16H3v5\"/>","chevron-right":"<path d=\"m9 18 6-6-6-6\"/>","chevron-left":"<path d=\"m15 18-6-6 6-6\"/>","x":"<path d=\"M18 6 6 18\"/><path d=\"m6 6 12 12\"/>","trash-2":"<path d=\"M3 6h18\"/><path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\"/><path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\"/><line x1=\"10\" x2=\"10\" y1=\"11\" y2=\"17\"/><line x1=\"14\" x2=\"14\" y1=\"11\" y2=\"17\"/>","link":"<path d=\"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\"/><path d=\"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\"/>"};

var SVGNS='http://www.w3.org/2000/svg';
function icon(name,size){
  var s=document.createElementNS(SVGNS,'svg');
  s.setAttribute('width',size||16); s.setAttribute('height',size||16);
  s.setAttribute('viewBox','0 0 24 24'); s.setAttribute('fill','none');
  s.setAttribute('stroke','currentColor'); s.setAttribute('stroke-width','2');
  s.setAttribute('stroke-linecap','round'); s.setAttribute('stroke-linejoin','round');
  s.setAttribute('aria-hidden','true');
  s.innerHTML=ICONS[name];
  return s;
}

/* Which finish each tone takes: steel gets panoramic (broad irregular banding
   gives a grey button something to look at), red gets the quieter brushed. */
var PLATE={steel:C.app+'/metal/panoramic-steel.webp', red:C.app+'/metal/brushed-red.webp'};