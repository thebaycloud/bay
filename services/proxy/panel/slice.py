import re, pathlib
v5 = pathlib.Path('/tmp/v5.js').read_text().split('\n')
def L(a,b):  # 1-indexed inclusive
    return '\n'.join(v5[a-1:b])

parts = {
  'icons'   : L(3,19),     # ICONS, SVGNS, icon(), PLATE
  'titles'  : L(101,101),  # TITLES
  'nav'     : L(107,109),  # topView/push/pop
  'helpers' : L(114,194),  # el, btn, kv, tintRow, avatars, statusChip
  'cells'   : L(238,336),  # cell, alertCell, homeScreen
  'feed'    : L(366,430),  # SOURCES, feedRow, rightNowCell
  'atoms'   : L(431,518),  # bars, stat, pad, li, pill, listOf, ini
  'screens' : L(520,695),  # screen, headingFor
}

def rename(s):
    # Collides with inject.ts's OWNER_JS globals (render/pop/api) or is renamed
    # for clarity. Method calls (stack.push, arr.pop) must survive untouched, so
    # every rule is anchored on "not preceded by a dot".
    s = re.sub(r'(?<![.\w])render\(', 'dwRender(', s)
    s = re.sub(r'(?<![.\w])push\(',   'dwPush(',   s)
    s = re.sub(r'(?<![.\w])pop\b(?!\w)', 'dwPop',  s)
    s = re.sub(r'\btopView\b',        'dwTop',     s)
    s = re.sub(r'\bstack\b',          'dwStack',   s)
    s = re.sub(r'(?<![.\w])\bdir\b',  'dwDir',     s)
    s = re.sub(r'\bfeedTimer\b',      'dwFeedTimer', s)
    return s

for k in parts: parts[k] = rename(parts[k])

# The plates are served by the control plane; the panel runs on the app's own
# origin, where "/metal/..." is the tenant's 404, not our image.
parts['icons'] = parts['icons'].replace(
  "var PLATE={steel:'/metal/panoramic-steel.webp', red:'/metal/brushed-red.webp'};",
  "var PLATE={steel:C.app+'/metal/panoramic-steel.webp', red:C.app+'/metal/brushed-red.webp'};")

# The feed reads a real stream off /_xray instead of the demo's five fake sources.
parts['feed'] = parts['feed'].replace('var all=STREAM[d.slug]||[];', 'var all=d.feed||[];')
parts['feed'] = re.sub(r"dwFeedTimer=setInterval\(tick,[^)]*\);", "dwFeedTimer=setInterval(tick,2200);", parts['feed'])

out = pathlib.Path('/private/tmp/claude-501/-Users-arsenkylysbek-dev-supersonicdeploy/d2fa5956-b004-4c93-a5d7-92df0fbb40c5/scratchpad/build')
for k,v in parts.items():
    (out/(k+'.js')).write_text(v)
    print('%-9s %5d bytes  %3d lines'%(k,len(v),v.count('\n')+1))
print('\nresidual STREAM refs:', sum('STREAM' in v for v in parts.values()))
print('residual bare render(:', sum(len(re.findall(r'(?<![.\w])render\(',v)) for v in parts.values()))
