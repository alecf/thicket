# Changelog

## [0.3.0](https://github.com/alecf/thicket/compare/v0.2.0...v0.3.0) (2026-11-05)


### Features

* move to the TypeScript 7.1 beta API ([#35](https://github.com/alecf/thicket/issues/35)) ([1cfda3d](https://github.com/alecf/thicket/commit/1cfda3dd706fdbdb5f4f421e65972fb287865b45))

## [0.2.0](https://github.com/alecf/thicket/compare/v0.1.0...v0.2.0) (2026-11-04)


### Features

* near copies on findings, measured against embeddings ([#31](https://github.com/alecf/thicket/issues/31)) ([6dba74b](https://github.com/alecf/thicket/commit/6dba74b0e868a10ee0cdd348567af7dd33092f25))


### Bug Fixes

* read *.e2e-spec.ts and *.e2e-test.ts as test files ([#33](https://github.com/alecf/thicket/issues/33))2 ([c065bcf](https://github.com/alecf/thicket/commit/c065bcf8db997940076ab6983fac2ab043e56831)), closes [#30](https://github.com/alecf/thicket/issues/30)

## 0.1.0 (2026-11-03)


### Features

* --embed, --private and --task, and a guide section for reporting bad findings ([#26](https://github.com/alecf/thicket/issues/26)) ([d7a677f](https://github.com/alecf/thicket/commit/d7a677fb2019d28e51146c1b402b8564c88a658d))
* --granularity dir, so no directory collapses into another ([43ed201](https://github.com/alecf/thicket/commit/43ed2016f96bf188364b3274c9b8d78308beb78b))
* --types include | exclude | only ([d5a7f60](https://github.com/alecf/thicket/commit/d5a7f6068da68a13d8786850d4899accf01919b3))
* add content-addressing hash ([421ba78](https://github.com/alecf/thicket/commit/421ba78fd46ee6e8776d7451c99ae4a64cd5808f))
* add content-derived finding ids and markdown report ([bf091dd](https://github.com/alecf/thicket/commit/bf091dd4c9ea648f0e65dff7fe3f08fcbc5c442a))
* add forEachChild wrapper that cannot abort early ([a1a6bb6](https://github.com/alecf/thicket/commit/a1a6bb655eef448e3a6c4fdf528a7d293631606a))
* add L0/L1 normalization with fragment-local alpha-renaming ([4a3154d](https://github.com/alecf/thicket/commit/4a3154da55e6a013458a2d72e8b11d71e790211e))
* add the content-addressed cache and wire it into the pipeline ([f9ab5ce](https://github.com/alecf/thicket/commit/f9ab5ce5470602d4f43188666da302f107aa54e3))
* add thicket diff for measuring loop progress ([0766d24](https://github.com/alecf/thicket/commit/0766d24a179b41846d85cf138f8a15cc73f6af54))
* add TS adapter with content-hash file dedup ([d7a4a7a](https://github.com/alecf/thicket/commit/d7a4a7a5bd04d659925fdc65b2b1d74bb532d457))
* adopt the pruning-shears mark, with the stem threaded between the jaws ([6f64d81](https://github.com/alecf/thicket/commit/6f64d8196585f56fa68b4ec856cbf6f1110e0b49))
* build module graph with SCC and propagation cost ([c08d78e](https://github.com/alecf/thicket/commit/c08d78e9a41da8de9151d5cfa97adab6fd80b608))
* cap intra-file repetition and strengthen the spread multiplier ([73042d3](https://github.com/alecf/thicket/commit/73042d3cf83889a33cfbc3ab43ce01268aa3b7f8))
* cluster fragments into L0/L1 duplication findings ([d55ee19](https://github.com/alecf/thicket/commit/d55ee19effa3ea8c24fb9d9ee1820815431dffd6))
* cross-reference findings that are near-variants of one shape ([18c771d](https://github.com/alecf/thicket/commit/18c771dd7945356d988d3359b8a24f286b5e842d))
* dissolve a dependency edge instead of cutting it, where it is only routing ([d5d3329](https://github.com/alecf/thicket/commit/d5d33297752da3f45a3e909f2f4c77a56970c0fa))
* draw each module tangle as a mermaid flowchart ([f2c82db](https://github.com/alecf/thicket/commit/f2c82db56413ae9315f9038be83837027e6ac3a8))
* exclude generated code by its own banner, and count it on neither side ([762877e](https://github.com/alecf/thicket/commit/762877e7a5faf270355c597d2a71872b157f3ae0))
* extract multi-granularity AST fragments ([fdc2f19](https://github.com/alecf/thicket/commit/fdc2f199a59614bf48af2af97f9e2f47804fda3e))
* group files into modules with common-prefix stripping ([58b41f2](https://github.com/alecf/thicket/commit/58b41f292375adb1b2073f11c5024cff14b27da7))
* lift a shared module prefix out of the chart into the heading ([750607d](https://github.com/alecf/thicket/commit/750607df34defac1014990cc603f7abd854ad330))
* make the module tangle sections honest and legible ([d19b577](https://github.com/alecf/thicket/commit/d19b5774947923271a4bc54d73b2a4ed84436ac6))
* name every duplicate location, name chart nodes by path, census the tail ([fb8be44](https://github.com/alecf/thicket/commit/fb8be44aea27acd3529ef39b4f1d9c9e13c749e3))
* name the constants a repeated shape is parameterized by ([b4b9962](https://github.com/alecf/thicket/commit/b4b9962bc70841f268db4ab5fe5c111a0b58988b))
* point at the same shape sitting in different surroundings ([6f67d9d](https://github.com/alecf/thicket/commit/6f67d9d7729da7c214816f96b256d6b5baf2472f))
* publish a GitHub Pages site, and link the report to its own field guide ([8d64f1e](https://github.com/alecf/thicket/commit/8d64f1e2da439bc0f5faf186d59c857615aa2acd))
* quote the source a finding points at ([9e4ad03](https://github.com/alecf/thicket/commit/9e4ad03f1247635a4d9fb50425ef87dd67972472))
* rank duplication by the lines a refactor would recover ([0d2c22a](https://github.com/alecf/thicket/commit/0d2c22adcebe3dd0cbc62db493b310a01c6af49f))
* rank duplication clusters and subsume nested findings ([aded0b7](https://github.com/alecf/thicket/commit/aded0b7cf6d8e7896d9ad5b8c9b1b58dd60f576d))
* rank duplication on a size curve, not lines removed ([#23](https://github.com/alecf/thicket/issues/23)) ([3657649](https://github.com/alecf/thicket/commit/365764955de3447901d50839199f459eac1a5f0d))
* rank on whether a refactor buys anything, not on how much is duplicated ([c8d4517](https://github.com/alecf/thicket/commit/c8d451736beefddf26f2818dd1c9a2905564efeb))
* record 1-based line numbers on fragments and occurrences ([b2ebce3](https://github.com/alecf/thicket/commit/b2ebce324883d522180144d0360604f875b35e78))
* report duplicated types in a section of their own ([3597bf2](https://github.com/alecf/thicket/commit/3597bf2be52d1df5a194cd77c0c3a8079b4f031f))
* report the tangle that survives type erasure, beside the whole one ([d1916bb](https://github.com/alecf/thicket/commit/d1916bbde07c4fa07520282f09005c525d60511f))
* resolve import specifiers via checker with case normalization ([c12c943](https://github.com/alecf/thicket/commit/c12c94391b6722e9344cb77c5a80fe4e215d30ef))
* run on bun, live from source, via the async TypeScript API ([0dabbad](https://github.com/alecf/thicket/commit/0dabbade4f911252c92d9bfdb8cfa1d9731338ce))
* say how much of a mixed edge is erased, not just whether all of it is ([04186e5](https://github.com/alecf/thicket/commit/04186e5eaa851ab561ec41048940406f55626c4a))
* say whether a module tangle is circular in the code or in the grouping ([1cb985d](https://github.com/alecf/thicket/commit/1cb985dddce5e0980e2c3b5e48d11193c4206565))
* see through re-export shims and barrels in a finding's surroundings ([fcb5a0e](https://github.com/alecf/thicket/commit/fcb5a0e8fbe53b6eb9d91380a8f79c6c16884660))
* select module granularity adaptively targeting sqrt(n) ([011e442](https://github.com/alecf/thicket/commit/011e44226a9b8ae4e2e63669f437895949f93c34))
* show enough of a copy to tell it apart, and where the copies land ([eb4009c](https://github.com/alecf/thicket/commit/eb4009c9521e6999040853eb88496f9b88efe5ed))
* state how much of the tree the program actually covered ([bdc27ac](https://github.com/alecf/thicket/commit/bdc27ac8b1e63648d687c5bc9555782e1fc70ad0))
* stop reporting shapes that are not refactors ([8bc9a07](https://github.com/alecf/thicket/commit/8bc9a0715fbe8dda1845842dea085a2a3830470e))
* tell each finding what surrounds it ([9d78bd8](https://github.com/alecf/thicket/commit/9d78bd8ccf3af650c2d4f13a37b5cd1478a487f7))
* wire thicket report end to end ([69a01c7](https://github.com/alecf/thicket/commit/69a01c713bcc3aad5a797fa3a66d286a2a81d5b2))


### Bug Fixes

* collapse a fuzzy cluster nested inside the exact one it restates ([347baf3](https://github.com/alecf/thicket/commit/347baf33da1b09fe8ed2838af44106a74e2a4f6e))
* demote type-only cuts instead of banning them ([b188342](https://github.com/alecf/thicket/commit/b18834236a0227764b787ede45cd15a259e48638))
* do not hang an L1 child's locations off an L0 finding ([f442e9d](https://github.com/alecf/thicket/commit/f442e9d78bf930048634f5230c01194e880c6f1c))
* emit valid Markdown ([467ab90](https://github.com/alecf/thicket/commit/467ab90cc1efd9bf51f839b300d57f783467fd03))
* escape raw NUL bytes in granularity prototype ([bc93257](https://github.com/alecf/thicket/commit/bc9325726642eafd7fde2f315b3f48ee968e90e7))
* exclude generated and vendored directories by default ([33400eb](https://github.com/alecf/thicket/commit/33400ebdf140128036deb7faa10f104165da6916))
* expand project references when a config owns no files ([fd193c6](https://github.com/alecf/thicket/commit/fd193c68d11c0eb44b4577c8da81c81e0506c541))
* fail loudly when a run analyzes zero source files ([1f76909](https://github.com/alecf/thicket/commit/1f76909010f199c1e3e4f9920189b37301bbb01d))
* let the Pages workflow enable Pages ([ab41e30](https://github.com/alecf/thicket/commit/ab41e30fdb4bebd45618b6d50d4d590d23f88e4d))
* make publishing the GitHub release re-runnable ([#3](https://github.com/alecf/thicket/issues/3)) ([065b177](https://github.com/alecf/thicket/commit/065b177cdec69e5be7cc242bdac26c6c3fe1bc59))
* mark a sampled count as a floor, and give the banner rule its own switch ([a3cc62d](https://github.com/alecf/thicket/commit/a3cc62d13aac88a90a730ff0b50029ebfc722631))
* match literal kinds by enum value, not reverse-mapped name ([cf975b4](https://github.com/alecf/thicket/commit/cf975b4aac60ec2f83700ba7df68b3f2f86d490c))
* quote mermaid edge labels, which the parenthesised type count broke ([17d1547](https://github.com/alecf/thicket/commit/17d15473b964b635269008fc8fb6e2103b2508d6))
* refuse a cut that shaves a tangle, and say what the best one would have left ([e14def1](https://github.com/alecf/thicket/commit/e14def1cb32492501965104055086620d480605f))
* replace localeCompare with environment-independent ordering ([8c9b0f7](https://github.com/alecf/thicket/commit/8c9b0f792e864f0fac462a6856b0cb9d628893e5))
* report duplication coverage as a true fraction of source bytes ([18f9aa5](https://github.com/alecf/thicket/commit/18f9aa5cd32f80820dad3733ef8ade379abfde76))
* restore the typecheck CI job ([72f408b](https://github.com/alecf/thicket/commit/72f408beecf438b5d5cc72ecf83a8bd997e05fa6))
* two site rendering bugs that only the built pages surfaced ([c424154](https://github.com/alecf/thicket/commit/c424154808328a10edbccabb838961d98a759176))
