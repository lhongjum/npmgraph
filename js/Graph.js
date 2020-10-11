import { html, useState, useEffect, useContext } from '../vendor/preact.js';
import { AppContext } from './App.js';
import { $, tagElement, entryFromKey, report, getDependencyEntries } from './util.js';
import Store from './Store.js';

const FONT = 'Roboto Condensed, sans-serif';

const EDGE_ATTRIBUTES = {
  dependencies: '[color=black]',
  devDependencies: '[color=red]',
  peerDependencies: '[color=green]'
  // optionalDependencies: '[color=black style=dashed]',
  // optionalDevDependencies: '[color=red style=dashed]'
};

/**
 * Fetch the module dependency tree for a given query
 * @param {[String]} query names of module entry points
 * @param {[String]} depIncludes dependencies to include
 * @returns {Promise<Map>} Map of key -> {module, level, dependencies}
 */
async function modulesForQuery(query, depIncludes) {
  const graph = new Map();

  function _walk(module, level = 0) {
    if (!module) return Promise.reject();

    // Array?  Apply to each element
    if (Array.isArray(module)) {
      return Promise.all(module.map(m => _walk(m, level)));
    }

    // Skip modules we've already seen
    if (graph.has(module.key)) return Promise.resolve();

    // Get dependency [name, version, dependency type] entries
    const depEntries = getDependencyEntries(module, depIncludes, level);

    // Create object that captures info about how this module fits in the dependency graph
    const info = { module, level };
    graph.set(module.key, info);

    return Promise.all(
      depEntries.map(([name, version, type]) =>
        Store.getModule(name, version)
          .then(module =>
            _walk(module, level + 1)
              .then(() => ({ module, type }))
          )
      )
    )
      .then(dependencies => info.dependencies = dependencies);
  }

  // Walk dependencies of each module in the query
  return Promise.all(query.map(async(name) => _walk(await Store.getModule(name))))
    .then(() => graph);
}

// Compose directed graph document (GraphViz notation)
function renderGraph(graph) {
  // Sort modules by [level, key]
  const entries = [...graph.entries()];
  entries.sort(([aKey, a], [bKey, b]) => {
    if (a.level != b.level) {
      a = a.level;
      b = b.level;
    } else {
      a = aKey;
      b = bKey;
    }

    return a < b ? -1 : a > b ? 1 : 0;
  });

  const nodes = ['\n// Nodes & per-node styling'];
  const edges = ['\n// Edges & per-edge styling'];

  for (const [, { module, level, dependencies }] of entries) {
    nodes.push(`"${module}"${level == 0 ? ' [root=true]' : ''}`);
    for (const { module: dependency, type } of dependencies) {
      edges.push(`"${module}" -> "${dependency}" ${EDGE_ATTRIBUTES[type]}`);
    }
  }

  const title = entries.filter(([, level]) => level == 0).map(m => m.package.name).join();
  const dotDoc = [
    'digraph {',
    'rankdir="LR"',
    'labelloc="t"',
    `label="${title}"`,
    '// Default styles',
    `graph [fontsize=16 fontname="${FONT}"]`,
    `node [shape=box style=rounded fontname="${FONT}" fontsize=11 height=0 width=0 margin=.04]`,
    `edge [fontsize=10, fontname="${FONT}" splines="polyline"]`,
    ''
  ]
    .concat(nodes)
    .concat(edges)
    .concat(
      graph.size > 1 ? `{rank=same; ${
          [...graph.values()].filter(info => info.level == 0).map(info => `"${info.module}"`).join('; ')
        };}` : ''
    )
    .concat('}')
    .join('\n');

  return Viz(dotDoc, {
    format: 'svg',
    scale: 1,
    totalMemory: 32 * 1024 * 1024 // See https://github.com/mdaines/viz.js/issues/89
  });
}

function zoom(op) {
  const svg = $('#graph svg').element;
  if (!svg) return;

  const vb = svg.getAttribute('viewBox').split(' ');

  switch (op) {
    case 0:
      svg.setAttribute('width', vb[2]);
      svg.setAttribute('height', vb[3]);
      break;

    case 1:
      svg.setAttribute('width', '100%');
      svg.removeAttribute('height');
      break;

    case 2:
      svg.removeAttribute('width');
      svg.setAttribute('height', '100%');
      break;
  }
}

function download(type) {
  switch (type) {
    case 'svg':
      downloadSvg();
      break;
    case 'png':
      downloadPng();
      break;
  }
}

function downloadPng() {
  const svg = $('svg');
  const data = $('svg').outerHTML;
  const vb = svg.getAttribute('viewBox').split(' ');

  const canvas = $.create('canvas');
  canvas.width = vb[2];
  canvas.height = vb[3];
  const ctx = canvas.getContext('2d');
  const DOMURL = window.URL || window.webkitURL || window;
  const img = new Image();
  const svgBlob = new Blob([data], { type: 'image/svg+xml' });
  const url = DOMURL.createObjectURL(svgBlob);
  img.onload = function() {
    ctx.drawImage(img, 0, 0);
    DOMURL.revokeObjectURL(url);
    const pngImg = canvas.toDataURL('image/png');
    generateLinkToDownload('png', pngImg);
  };
  img.src = url;
}

function downloadSvg() {
  alert('Note: Make sure you have the "Roboto Condensed" font installed, available at https://fonts.google.com/specimen/Roboto+Condensed.');

  const svgData = $('svg').outerHTML;
  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);
  generateLinkToDownload('svg', svgUrl);
}

function generateLinkToDownload(extension, link) {
  const name = $('title').innerText.replace(/.*- /, '').replace(/\W+/g, '_');
  const downloadLink = $.create('a');
  downloadLink.href = link;
  downloadLink.download = `${name}_dependencies.${extension}`;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  document.body.removeChild(downloadLink);
}

function selectTag(tag) {
  // If tag (element) is already selected, do nothing
  if (tag && tag.classList && tag.classList.contains('selected')) return;

  $('svg .node').forEach(el => el.classList.remove('selected'));
  if (typeof (tag) == 'string') {
    $(`svg .node.${tag}`).forEach((el, i) => el.classList.add('selected'));
  } else if (tag) {
    tag.classList.add('selected');
  }
}

function Loader({ complete, total, ...props }) {
  const perc = complete / total * 100;
  return html`
    <div className="loader" ...${props}>
      <div className="inner" style=${{ width: `${perc}%` }} />
    </div>
  `;
}

function GraphControls() {
  return html`
    <div className="graph-controls" >
      <button onClick=${() => zoom(1)} title="zoom (fit width)" class="material-icons" style="border-radius: 3px 0 0 3px">swap_horiz</button>
      <button onClick=${() => zoom(0)} title="zoom (1:1)" class="material-icons" style="border-width: 1px 0px; border-radius: 0">search</button>
      <button onClick=${() => zoom(2)} title="zoom (fit height)" class="material-icons" style="border-radius: 0 3px 3px 0">swap_vert</button>
      <button onClick=${() => download('svg')} title="download as SVG" class="material-icons" style="margin-left: 0.5em">cloud_download</button>
    </div>
  `;
}

export default function Graph() {
  const {
    query: [query],
    depIncludes: [depIncludes],
    pane: [, setPane],
    module: [, setModule],
    graph: [, setGraph]
  } = useContext(AppContext);

  const [loadStats, setLoadStats] = useState(null);
  const [zoom, setZoom] = useState(1);

  async function handleGraphClick(event) {
    const el = $.up(event.srcElement, e => e.classList.contains('node'));

    selectTag(el);

    const module = el && await Store.getModule(...entryFromKey(el.textContent.trim()));

    setModule(module);
    setPane(module ? 'module' : 'graph');

    // Inspector.toggle(false);
  }

  useEffect(async() => {
    $('#graph svg').remove();

    setGraph([]);
    setModule([]);

    Store.onRequest = stats => {
      setLoadStats({ ...stats });
    };

    const graph = await modulesForQuery(query, depIncludes);
    // TODO: Replace Viz with Dagre
    const markup = renderGraph(graph);

    // Compose SVG markup
    const svg = new DOMParser().parseFromString(markup, 'text/html').querySelector('svg');
    $(svg, 'g title').remove();

    // Round up viewbox
    svg.setAttribute('viewBox', svg.getAttribute('viewBox').split(' ').map(Math.ceil).join(' '));

    $(svg, 'g.node').forEach(async el => {
      const key = $(el, 'text').element.textContent;
      if (!key) return;

      const moduleName = key.replace(/@[\d.]+$/, '');
      if (moduleName) {
        tagElement(el, 'module', moduleName);
      } else {
        report.warn(Error(`Bad replace: ${key}`));
      }

      const m = await Store.getModule(...entryFromKey(key));
      const pkg = m.package;
      if (pkg.maintainers.length < 2) {
        el.classList.add('bus'); // Module maintainer might get hit by bus :-o
      }

      if (pkg.stub) {
        el.classList.add('stub');
      } else {
        tagElement(el, 'maintainer', ...pkg.maintainers.map(m => m.name));
        tagElement(el, 'license', m.licenseString || 'Unspecified');
      }
    });

    $('#graph').appendChild(svg);

    setGraph(graph);
    setPane('graph');

    // zoom(1);

    // Inspector.setGraph(modules);
    // Inspector.setModule(modules);
    // Inspector.showPane('pane-graph');
    // Inspector.toggle(true);

    return () => {
      delete Store.onRequest;
    };
  }, [query, depIncludes]);

  $('title').innerText = `NPMGraph - ${query.join(', ')}`;

  return html`
    <div id="graph" onClick=${handleGraphClick} >
      ${loadStats?.active ? html`<${Loader} complete=${loadStats.complete} total=${loadStats.active + loadStats.complete} />` : null}
      <${GraphControls} />
    </div>
  `;
}