/**
 * CommonJS 垫片（Android 侧的粘合代码，**不是 Core 的一部分**）。
 *
 * 为什么需要：
 *   src/core 与 src/shared 里的 JS 是 Node CommonJS 风格（`require` / `module.exports`）。
 *   QuickJS 本身不认识 CommonJS。与其引入打包器（esbuild / rollup）把源码编译一遍，
 *   不如运行时提供这几十行垫片 —— 这样**源码一个字都不用改**，
 *   也避免出现"Android 专用打包产物"，与 Windows 侧保持同一份源码。
 *
 * 模块名用**仓库内相对路径**（例如 `src/shared/redact.js`）。
 * assets 里刻意保持了仓库原始的目录结构，所以
 * `src/core/auto-connect.js` 里的 `require('../shared/constants')`
 * 用一个最朴素的路径拼接就能解析，不需要额外的路径映射表。
 */
(function (global) {
  var modules = {}; // name -> factory(module, exports, require)
  var cache = {}; // name -> module.exports

  function normalize(name) {
    return /\.js$/.test(name) ? name : name + '.js';
  }

  /** 把 './x'、'../y/z' 相对当前模块名解析成规范化模块名 */
  function resolveRelative(fromName, request) {
    var base = fromName.split('/');
    base.pop(); // 去掉文件名，留下所在目录
    var parts = request.split('/');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '.' || p === '') continue;
      if (p === '..') base.pop();
      else base.push(p);
    }
    return normalize(base.join('/'));
  }

  function instantiate(name) {
    if (Object.prototype.hasOwnProperty.call(cache, name)) return cache[name];
    var factory = modules[name];
    if (!factory) {
      throw new Error('CommonJS shim: 模块未注册 -> ' + name);
    }
    var mod = { exports: {} };
    cache[name] = mod.exports; // 先登记，允许循环依赖
    factory(mod, mod.exports, function (request) {
      return load(resolveRelative(name, request));
    });
    cache[name] = mod.exports;
    return mod.exports;
  }

  function load(name) {
    return instantiate(normalize(name));
  }

  global.__cjs = {
    /** 注册一个模块。name 用仓库内路径，例如 'src/shared/constants.js' */
    define: function (name, factory) {
      modules[normalize(name)] = factory;
    },
    /**
     * 从任意入口 require 一个模块。
     *   · 以 '.' 开头：相对入口解析（源码里最常见的写法）
     *   · 否则：当作仓库根相对路径，例如 'src/shared/redact'
     */
    require: function (request) {
      if (request.charAt(0) === '.') {
        return load(resolveRelative('src/entry.js', request));
      }
      return load(request);
    },
    /** 已注册的模块名（自检/排错用） */
    registered: function () {
      return Object.keys(modules);
    },
  };
})(this);
