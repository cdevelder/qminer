// QMiner - Open Source Analytics Platform
// 
// Copyright (C) 2014 Jozef Stefan Institute
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License, version 3,
// as published by the Free Software Foundation.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <http://www.gnu.org/licenses/>.

var util = require("utilities.js");

exports = require("__analytics__");

function createBatchModel(featureSpace, models) {
    this.featureSpace = featureSpace;
    this.models = models;
    // serialize to stream
    this.save = function (sout) {
        // save list
        sout.writeLine(this.models);
        // save feature space
        this.featureSpace.save(sout);
        // save models
        for (var cat in this.models) {
            this.models[cat].model.save(sout);
        }
    }
    // prediction
    this.predict = function (record) {
        var vec = this.featureSpace.ftrSpVec(record);
        var result = { };
        for (var cat in this.models) {
            result[cat] = this.models[cat].model.predict(vec);
        }
        return result;
    }
    return this;
}

//#- `model = analytics.newBatchModel(records, features, target)` -- learns a new batch model
//#     using `records` as training data and `features` as feature space; `target` is
//#     a field for the records which we are trying to predict (e.g. store.field("Rating");
//#     if target field string or string vector, the result is a SVM classification model,
//#     and if target field is a float, the result is a SVM regression model; resulting 
//#     model has the following functions:
//#   - `result = model.predict(record)` -- creates feature vector from `record`, sends it
//#     through the model and returns the result as an array of scores.
//#   - `model.save(fout)` -- saves the model to `fout` output stream
exports.newBatchModel = function (records, features, target) {
    console.log("newBatchModel", "Start");
    // prepare feature space
    console.log("newBatchModel", "  creating feature space");
    var featureSpace = exports.newFeatureSpace(features);
    // initialize features
    featureSpace.updateRecords(records);
    console.log("newBatchModel", "  number of dimensions = " + featureSpace.dim);    
    // prepare spare vectors
    console.log("newBatchModel", "  preparing feature vectors");   
    var sparseVecs = featureSpace.ftrSpColMat(records);
    // prepare target vectors
    var targets = { };
    // figure out if new category name, or update count
    function initCats(categories, catName) {
        if (categories[catName]) {
            categories[catName].count++; 
        } else {
            categories[catName] = { 
                name: catName, 
                type: "classification",
                count: 1, 
                target: linalg.newVec({mxVals : records.length})
            };
        }
    }   
    // initialize targets
    console.log("newBatchModel", "  preparing target vectors");
    if (target.type === "string_v") {
        // get all possible values for the field
        for (var i = 0; i < records.length; i++) {
            var cats = records[i][target.name];
            for (var j = 0; j < cats.length; j++) {
                initCats(targets, cats[j]);
            }
        }
        // initialized with +1 or -1 for each category
        for (var i = 0; i < records.length; i++) {
            var cats = records[i][target.name];
            for (var cat in targets) {
                targets[cat].target.push(util.isInArray(cats, cat) ? 1.0 : -1.0);
            }
        }
    } else if (target.type === "float") {
        // initialized with +1 or -1 for each category
        targets[target.name] = { 
            name: target.name,
            type: "regression",
            count: records.length,
            target: linalg.newVec({mxVals : records.length})                    
    
        };
        for (var i = 0; i < records.length; i++) {
            targets[target.name].target.push(records[i][target.name]);
        }        
    }
    // training model for each category
    console.log("newBatchModel", "  training SVM");
    var models = { };
    for (var cat in targets) {
        if (targets[cat].count >= 20) {
            models[cat] = {
                name : targets[cat].name,
                type : targets[cat].type,
            };
            if (targets[cat].type === "classification") {
                console.log("newBatchModel", "    ... " + cat + " (classification)");
                models[cat].model = exports.trainSvmClassify(sparseVecs, targets[cat].target);
            } else if (targets[cat].type === "regression") {
                console.log("newBatchModel", "    ... " + cat + " (regression)");
                models[cat].model = exports.trainSvmRegression(sparseVecs, targets[cat].target);
            }
        }
    }
    // done
    console.log("newBatchModel", "Done");  
    // we finished the constructor
    return new createBatchModel(featureSpace, models);
}

//#- `analytics.loadBatchModel(fin)` -- loads batch model frm input stream `fin`
exports.loadBatchModel = function (sin) {
    var models = JSON.parse(sin.readLine());
    var featureSpace = exports.loadFeatureSpace(sin);
    for (var cat in models) {        
        models[cat].model = exports.loadSvmModel(sin);
    }
    // we finished the constructor
    return new createBatchModel(featureSpace, models);    
}

// active learning (analytics:function activeLearner, parameters
//#- `model = new analytics.activeLearner(ftrSpace, textField, recSet, nPos, nNeg, query)`
exports.activeLearner = function (ftrSpace, textField, recSet, nPos, nNeg, query) {
    var store = recSet.store;
    var X = la.newSpMat();
    var y = la.newVec();
    // QUERY MODE
    var queryMode = true;
    // bow similarity between query and training set 
    var queryRec = store.newRec({ textField: query }); // record
    var querySpVec = ftrSpace.ftrSpVec(queryRec); // query sparse vector
    querySpVec.normalize();
    var recsMat = ftrSpace.ftrSpColMat(recSet); //recSet feature matrix
    recsMat.normalizeCols();
    var simV = recsMat.multiplyT(querySpVec); //similarities (q, recSet)
    var sortedSimV = simV.sortPerm(); //ascending sort
    var simVs = sortedSimV.vec; //sorted similarities (q, recSet)
    var simVp = sortedSimV.perm; //permutation of sorted similarities (q, recSet)
    // counters for questions in query mode
    var nPosQ = 0; //for traversing simVp from the end
    var nNegQ = 0; //for traversing simVp from the start

    // SVM MODE
    var svm;
    var posIdxV = la.newIntVec(); //indices in recordSet
    var negIdxV = la.newIntVec(); //indices in recordSet
    var posIdV = la.newIntVec(); //record IDs
    var negIdV = la.newIntVec(); //record IDs
    var classVec = la.newVec({ "vals": recSet.length }); //svm scores for record set

    // returns record set index of the unlabeled record that is closest to the margin
    this.selectQuestion = function () {
        if (posIdV.length >= nPos && negIdV.length >= nNeg) { queryMode = false; }
        if (queryMode) {
            if (posIdV.length < nPos) {
                nPosQ = nPosQ + 1;
                console.say("query mode, try to get pos");
                this.getAnswer(simVp[simVp.length - 1 - (nPosQ - 1)]);
            }
            if (negIdV.length < nNeg) {
                nNegQ = nNegQ + 1;
                console.say("query mode, try to get neg");
                this.getAnswer(simVp[nNegQ - 1]);
            }
        }
        else {
            ////call svm, get record closest to the margin            
            //console.startx(function (x) { return eval(x); });
            svm = analytics.trainSvmClassify(X, y); //column examples, y float vector of +1/-1, default svm paramvals
            // mark positives
            for (var i = 0; i < posIdxV.length; i++) { classVec[posIdxV[i]] = Number.POSITIVE_INFINITY; }
            // mark negatives
            for (var i = 0; i < negIdxV.length; i++) { classVec[negIdxV[i]] = Number.POSITIVE_INFINITY; }
            var posCount = posIdxV.length;
            var negCount = negIdxV.length;
            // classify unlabeled
            for (var recN = 0; recN < recSet.length; recN++) {
                if (classVec[recN] !== Number.POSITIVE_INFINITY) {

                    var svmMargin = svm.predict(recsMat[recN]);
                    if (svmMargin > 0) {
                        posCount++;
                    } else {
                        negCount++;
                    }
                    classVec[recN] = Math.abs(svmMargin);
                }
            }
            var sorted = classVec.sortPerm();
            console.say("svm mode, margin: " + sorted.vec[0] + ", npos: " + posCount + ", nneg: " + negCount);
            this.getAnswer(sorted.perm[0]);
        }
    };
    // asks the user for class label given a record set index
    this.getAnswer = function (recSetIdx) {
        //todo options: ?newQuery        
        console.say(recSet[recSetIdx].Text + ": y/(n)/stop?");
        var ALanswer = console.getln();
        if (ALanswer !== "stop") {
            if (ALanswer === "y") {
                posIdxV.push(recSetIdx);
                posIdV.push(recSet[recSetIdx].$id);
                X.push(recsMat[recSetIdx]);
                y.push(1.0);
            } else {
                negIdxV.push(recSetIdx);
                negIdV.push(recSet[recSetIdx].$id);
                X.push(recsMat[recSetIdx]);
                y.push(-1.0);
            }
            this.selectQuestion();
        }
        // +k query // rank unlabeled according to query, ask for k most similar
        // -k query // rank unlabeled according to query, ask for k least similar
    };
    this.saveSvmModel = function (outputStream) {
        // must be in SVM mode
        if (queryMode) {
            console.say("AL.save: Must be in svm mode");
            return;
        }
        svm.save(outputStream);
    };
    //this.saveLabeled
    //this.loadLabeled
};


//////////// RIDGE REGRESSION 
// solve a regularized least squares problem
//#- `model = new analytics.ridgeRegression(kapa, dim, buffer)`
exports.ridgeRegression = function(kapa, dim, buffer) {
    var X = [];
    var y = [];
    buffer = typeof buffer !== 'undefined' ? buffer : -1;
    var w = la.newVec({ "vals": dim });

    this.add = function (x, target) {
        X.push(x);
        y.push(target);
        if (buffer > 0) {
            if (X.length > buffer) {
                this.forget(X.length - buffer);
            }
        }
    };
    this.addupdate = function (x, target) {
        this.add(x, target);
        this.update();
    }
    this.forget = function (ndeleted) {
        ndeleted = typeof ndeleted !== 'undefined' ? ndeleted : 1;
        ndeleted = Math.min(X.length, ndeleted);
        X.splice(0, ndeleted);
        y.splice(0, ndeleted);
    };
    this.update = function () {
        var A = this.getMatrix();
        var b = la.copyFltArrayToVec(y);
        w = this.compute(A, b);
    };
    this.getModel = function () {
        return w;
    };
    this.getMatrix = function () {
        if (X.length > 0) {
            var A = la.newMat({ "cols": X[0].length, "rows": X.length });
            for (var i = 0; i < X.length; i++) {
                A.setRow(i, X[i]);
            }
            return A;
        }
    };
    this.compute = function (A, b) {
        var I = la.eye(A.cols);
        var coefs = (A.transpose().multiply(A).plus(I.multiply(kapa))).solve(A.transpose().multiply(b));
        return coefs;
    };

    this.predict = function (x) {
        return w.inner(x);
    };
};

///////// CLUSTERING BATCH K-MEANS
//#- `model = new analytics.kmeans(X, k, iter)`
exports.kmeans = function(X, k, iter) {
    // select random k columns of X, returns a dense C++ matrix
    this.selectCols = function (X, k) {
        var idx = la.randIntVec(X.cols, k);
        var idxMat = la.newSpMat({ "rows": X.cols });
        for (var i = 0; i < idx.length; i++) {
            var spVec = la.newSpVec([[idx[i], 1.0]], { "dim": X.cols });
            idxMat.push(spVec);
        }
        var C = X.multiply(idxMat);
        var result = new Object();
        result.C = C;
        result.idx = idx;
        return result;
    };

    // modified k-means algorithm that avoids empty centroids
    // A Modified k-means Algorithm to Avoid Empty Clusters, Malay K. Pakhira
    // http://www.academypublisher.com/ijrte/vol01/no01/ijrte0101220226.pdf
    this.getCentroids = function (X, idx, oldC) {
        // select random k columns of X, returns a dense matrix
        // 1. construct a sparse matrix (coordinate representation) that encodes the closest centroids
        var idxvec = la.copyIntArrayToVec(idx);
        var rangeV = la.rangeVec(0, X.cols - 1);
        var ones_cols = la.ones(X.cols);
        var idxMat = la.newSpMat(idxvec, rangeV, ones_cols, X.cols);
        idxMat = idxMat.transpose();
        var ones_n = la.ones(X.cols);
        // 2. compute the number of points that belong to each centroid, invert
        var colSum = idxMat.multiplyT(ones_n);
        for (var i = 0; i < colSum.length; i++) {
            var val = 1.0 / (1.0 + colSum.at(i)); // modification
            colSum.put(i, val);
        }
        // 3. compute the centroids
        var w = new util.clsStopwatch();
        w.tic();
        var sD = colSum.spDiag();
        var C = ((X.multiply(idxMat)).plus(oldC)).multiply(sD); // modification
        return C;
    };


    // X: column examples
    // k: number of centroids
    // iter: number of iterations
    assert.ok(k <= X.cols, "k <= X.cols");
    var w = new util.clsStopwatch();
    var norX2 = la.square(X.colNorms());
    var initialCentroids = this.selectCols(X, k);
    var C = initialCentroids.C;
    var idxvOld = initialCentroids.idx;
    //printArray(idxvOld); // DEBUG
    var ones_n = la.ones(X.cols).multiply(0.5);
    var ones_k = la.ones(k).multiply(0.5);
    w.tic();
    for (var i = 0; i < iter; i++) {
        console.say("iter: " + i);
        var norC2 = la.square(C.colNorms());
        //D =  full(C'* X) - norC2' * (0.5* ones(1, n)) - (0.5 * ones(k,1) )* norX2';
        var D = C.multiplyT(X).minus(norC2.outer(ones_n)).minus(ones_k.outer(norX2));
        var idxv = la.findMaxIdx(D);
        //var energy = 0.0;
        //for (var j = 0; j < X.cols; j++) {            
        //    if (D.at(idxv[j],j) < 0) {
        //        energy += Math.sqrt(-2 * D.at(idxv[j], j));
        //    }
        //}
        //console.say("energy: " + 1.0/ X.cols * energy);
        if (util.arraysIdentical(idxv, idxvOld)) {
            console.say("converged at iter: " + i); //DEBUG
            break;
        }
        idxvOld = idxv.slice();
        C = this.getCentroids(X, idxv, C); //drag
    }
    w.toc("end");
    return C;
};

////////////// ONLINE CLUSTERING (LLOYD ALGORITHM)
//#- `model = new analytics.lloyd(dim, k)`
exports.lloyd = function (dim, k) {
    // Private vars
    var C = la.genRandomMatrix(dim, k);//linalg.newMat({ "rows": dim, "cols": k, "random": true });;
    var counts = la.ones(k);
    var norC2 = la.square(C.colNorms());

    this.init = function () {
        C = la.genRandomMatrix(dim, k); //linalg.newMat({ "rows": dim, "cols": k, "random": true });
        counts = la.ones(k);
        norC2 = la.square(C.colNorms());
    };

    this.getC = function () {
        return C;
    };

    this.giveAll = function () {
        var result = new Object();
        result.C = C;
        result.counts = counts;
        result.norC2 = norC2;
        return result;
    };
    this.setC = function (C_) {
        C = la.newMat(C_);
        norC2 = la.square(C.colNorms());
    };
    this.update = function (x) {
        var idx = this.getCentroidIdx(x);
        //C(:, idx) = 1/(counts[idx] + 1)* (counts[idx] * C(:, idx)  + x);
        var vec = ((C.getCol(idx).multiply(counts[idx])).plus(x)).multiply(1.0 / (counts[idx] + 1.0));
        C.setCol(idx, vec);
        counts[idx] = counts[idx] + 1;
        norC2[idx] = la.square(vec.norm());
    };
    this.getCentroid = function (x) {
        var idx = this.getCentroidIdx(x);
        var vec = C.getCol(idx);
        return vec;
    };
    this.getCentroidIdx = function (x) {
        var D = C.multiplyT(x);
        D = D.minus(norC2.multiply(0.5));
        var idxv = la.findMaxIdx(D);
        return idxv[0];
    };
};

/////////// perceptron : 0/1 classification
//#- `model = new analytics.perceptron(dim, use_bias)`
exports.perceptron = function (dim, use_bias) {
    use_bias = typeof use_bias !== 'undefined' ? use_bias : false;
    var w = la.newVec({ "vals": dim });
    var b = 0;

    this.update = function (x, y) {
        var yp = (w.inner(x) + b) > 0;
        if (y != yp) {
            var e = y - yp;
            w = w.plus(x.multiply(e));
            if (use_bias) {
                b = b + e;
            }
        }
    };

    this.predict = function (x) {
        return (w.inner(x) + b) > 0;
    };

    this.getModel = function () {
        var model;
        model.w = w;
        model.b = b;
        return model;
    };

};