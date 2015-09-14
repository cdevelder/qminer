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
var assert = require("assert.js");

module.exports = require("__analytics__");
exports = module.exports; // re-establish link

function createBatchModel(featureSpace, models) {
    this.featureSpace = featureSpace;
    this.models = models;
    // get targets, i.e., labels for which we have models
    this.target = [];
    for (var cat in this.models) { this.target.push(cat); }
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
        return sout;
    };

    this.predict = function (record) {
        var vec = this.featureSpace.ftrSpVec(record);
        var result = { };
        for (var cat in this.models) {
            result[cat] = this.models[cat].model.predict(vec);
        }
        return result;
    };

    this.predictLabels = function (record) {
        var result = this.predict(record);
        var labels = [];
        for (var cat in result) { 
            if (result[cat] > 0.0) { 
                labels.push(cat); 
            }
        }
        return labels;
    };
    
    this.predictTop = function (record) {
        var result = this.predict(record);
        var top = null;
        for (var cat in result) {
            if (top) {
                if (top.weight > result[cat]) {
                    top.category = cat;
                    top.weight = result[cat];
                }
            } else {
                top = { category : cat, weight: result[cat] }
            }
        }
        return top.category;
    };
    
    return this;
}

//#- `batchModel = analytics.newBatchModel(rs, features, target)` -- learns a new batch model
//#     using record set `rs` as training data and `features`; `target` is
//#     a field descriptor JSON object for the records which we are trying to predict (obtained by calling store.field("Rating");
//#     if target field string or string vector, the result is a SVM classification model,
//#     and if target field is a float, the result is a SVM regression model; resulting 
//#     model has the following functions:
//#   - `strArr = batchModel.target` -- array of categories for which we have models
//#   - `scoreArr = batchModel.predict(rec)` -- creates feature vector from record `rec`, sends it
//#     through the model and returns the result as a dictionary where labels are keys and scores (numbers) are values.
//#   - `labelArr = batchModel.predictLabels(rec)` -- creates feature vector from record `rec`, 
//#     sends it through the model and returns the labels with positive weights as `labelArr`.
//#   - `labelStr = batchModel.predictTop(rec)` -- creates feature vector from record `rec`, 
//#     sends it through the model and returns the top ranked label `labelStr`.
//#   - `batchModel.save(fout)` -- saves the model to `fout` output stream
exports.newBatchModel = function (records, features, target, limitCategories) {
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
    // figure out if new category name, or update counts
    function initCats(categories, catName) {
        if (categories[catName]) {
            categories[catName].count++; 
        } else if ( !limitCategories || util.isInArray(limitCategories, catName) ) {
            // only initialize if we don't limit cats, or it's to be included
            categories[catName] = { 
                name: catName, 
                type: "classification",
                count: 1, 
                target: linalg.newVec({mxVals : records.length})
            };
        }
    };

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
    } else if (target.type === "string") {
        // get all possible values for the field
        for (var i = 0; i < records.length; i++) {
            var recCat = records[i][target.name];
            initCats(targets, recCat);
        }
        // initialized with +1 or -1 for each category
        for (var i = 0; i < records.length; i++) {
            var recCat = records[i][target.name];
            for (var cat in targets) {
                targets[cat].target.push((recCat === cat) ? 1.0 : -1.0);
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
        if (targets[cat].count >= 50) {
            models[cat] = {
                name : targets[cat].name,
                type : targets[cat].type,
            };
            if (targets[cat].type === "classification") {
                console.log("newBatchModel", "    ... " + cat + " (classification)");
                models[cat].model = exports.trainSvmClassify(sparseVecs, targets[cat].target, 
                    { c: 1, j: 10, batchSize: 10000, maxIterations: 100000, maxTime: 1800, minDiff: 0.001 });
            } else if (targets[cat].type === "regression") {
                console.log("newBatchModel", "    ... " + cat + " (regression)");
                models[cat].model = exports.trainSvmRegression(sparseVecs, targets[cat].target, 
                    { c: 1, eps: 1e-2, batchSize: 10000, maxIterations: 100000, maxTime: 1800, minDiff: 0.001 });
            }
        }
    }
    // done
    console.log("newBatchModel", "Done");  
    // we finished the constructor
    return new createBatchModel(featureSpace, models);
};

//#- `batchModel = analytics.loadBatchModel(fin)` -- loads batch model frm input stream `fin`
exports.loadBatchModel = function (sin) {
    var models = JSON.parse(sin.readLine());
    var featureSpace = exports.loadFeatureSpace(sin);
    for (var cat in models) {        
        models[cat].model = exports.loadSvmModel(sin);
    }
    // we finished the constructor
    return new createBatchModel(featureSpace, models);    
};

//#- `cs = new analytics.classificationScore(cats)` -- for evaluating 
//#     provided categories. Returns an object, which can track classification
//#     statistics (precision, recall, F1).
exports.classificationScore = function (cats) {
    // Function body for classificationScore
    this.target = { }; // results for each category
	
    //#    - `cs.addCategory(cat)` -- adds category `cat` to the targets
    //#         to track performance for. *Note:* `cat` only gets added if
    //#         it was not there before
    this.addCategory = function (cat) {
        if (!(cat in this.target)) {
            this.target[cat] = {
                count: 0, predictionCount: 0,
                TP: 0, TN: 0, FP: 0, FN: 0,
                all : function () { return this.TP + this.FP + this.TN + this.FN; },
                precision : function () { return (this.FP == 0) ? 1 : this.TP / (this.TP + this.FP); },
                recall : function () { return this.TP / (this.TP + this.FN); },
                f1: function () { return 2 * this.precision() * this.recall() / (this.precision() + this.recall()); },
                accuracy : function () { return (this.TP + this.TN) / this.all(); }
            };
        }
    };

    for (var i = 0; i < cats.length; i++) {
		this.addCategory(cats[i]);
	}
	
    //#    - `cs.count(correct, predicted)` -- adds prediction to the current
    //#         statistics. `correct` corresponds to the correct label(s), `predicted`
    //#         corresponds to predicted label(s). Labels can be either string
    //#         or string array (when there are zero or more then one labels).
	this.count = function (correct, predicted) {
        // wrap classes in arrays if not already
        if (util.isString(correct)) { this.count([correct], predicted); return; }
        if (util.isString(predicted)) { this.count(correct, [predicted]); return; }
        // go over all possible categories and counts
        for (var cat in this.target) {
            var catCorrect = util.isInArray(correct, cat);
            var catPredicted = util.isInArray(predicted, cat);            
            // update counts for correct categories
            if (catCorrect) { this.target[cat].count++; }
            // update counts for how many times category was predicted
            if (catPredicted) { this.target[cat].predictionCount++; }
            // update true/false positive/negative count
            if (catCorrect && catPredicted) {
                // both predicted and correct say true
                this.target[cat].TP++;
            } else if (catCorrect) {
                // this was only correct but not predicted
                this.target[cat].FN++;
            } else if (catPredicted) {
                // this was only predicted but not correct
                this.target[cat].FP++;
            } else {
                // both predicted and correct say false
                this.target[cat].TN++;
            }
            // update confusion matrix
        }
	};

    //#    - `cs.report()` -- prints current statisitcs for each category
	this.report = function () { 
		for (var cat in this.target) {
			console.log(cat + 
				": Count " + this.target[cat].count + 
				", All " + this.target[cat].all() + 
				", Precision " + this.target[cat].precision().toFixed(2) + 
				", Recall " +  this.target[cat].recall().toFixed(2) +
				", F1 " + this.target[cat].f1().toFixed(2) +
				", Accuracy " + this.target[cat].accuracy().toFixed(2));
		}
	};
    
    //#    - `cs.reportAvg()` -- prints current statisitcs averaged over all cagtegories
    this.reportAvg = function () {
        var count = 0, precision = 0, recall = 0, f1 = 0, accuracy = 0; 
        for (var cat in this.target) {
            count++;
            precision = precision + this.target[cat].precision();
            recall = recall + this.target[cat].recall();
            f1 = f1 + this.target[cat].f1();
            accuracy = accuracy + this.target[cat].accuracy();
        }
        console.log("Categories " + count + 
            ", Precision " + (precision / count).toFixed(2) + 
            ", Recall " +  (recall / count).toFixed(2) +
            ", F1 " + (f1 / count).toFixed(2) +
            ", Accuracy " + (accuracy / count).toFixed(2));        
    };

    //#    - `cs.reportCSV(fout)` -- current statisitcs for each category to fout as CSV 
	this.reportCSV = function (fout) { 
		// precison recall
		fout.writeLine("category,count,precision,recall,f1,accuracy");
		for (var cat in this.target) {
			fout.writeLine(cat + 
				"," + this.target[cat].count + 
				"," + this.target[cat].precision().toFixed(2) + 
				"," + this.target[cat].recall().toFixed(2) +
				"," + this.target[cat].f1().toFixed(2) +
				"," + this.target[cat].accuracy().toFixed(2));
		}
        return fout;
	};
	
    //#    - `res = cs.results()` -- get current statistics; `res` is an array
    //#         of object with members `precision`, `recall`, `f1` and `accuracy`
	this.results = function () {
		var res = { };
		for (var cat in this.target) {
			res[cat] = {
				precision : this.target[cat].precision(),
				recall    : this.target[cat].recall(),
				f1        : this.target[cat].f1(),
				accuracy  : this.target[cat].accuracy(),
			};
		}
	};
};

//#- `result = new exports.rocScore(sample)` -- used for computing ROC curve and 
//#     other related measures such as AUC; the result is a results object
//#     with the following API:
exports.rocScore = function () {
	// count of all the positive and negative examples
	this.allPositives = 0;
	this.allNegatives = 0;
	// store of predictions and ground truths
	this.grounds = la.newVec();
	this.predictions = la.newVec();
	
	//#     - `result.push(ground, predict)` -- add new measurement with ground score (1 or -1) and predicted value
	this.push = function (ground, predict) {
		// remember the scores
		this.grounds.push(ground)
		this.predictions.push(predict);
		// update counts
		if (ground > 0) { 
			this.allPositives++; 
		} else {
			this.allNegatives++;
		}
	}
	
	//#     - `roc_arr = result.curve(sample)` -- get ROC parametrization as array of sample points
	this.curve = function (sample) {
		// default sample size is 10
		sample = sample || 10;
		// sort according to predictions
		var perm = this.predictions.sortPerm(false);
		// maintaining the results as we go along
		var TP = 0, FP = 0, ROC = [[0, 0]];
		// for figuring out when to dump a new ROC sample
		var next = Math.floor(perm.perm.length / sample);
		// go over the sorted results
		for (var i = 0; i < perm.perm.length; i++) {
			// get the ground
			var ground = this.grounds[perm.perm[i]];
			// update TP/FP counts according to the ground
			if (ground > 0) { TP++ } else { FP++; }
			// see if time to do next save
			next = next - 1;		
			if (next <= 0) {
				// add new datapoint to the curve 
				ROC.push([FP/this.allNegatives, TP/this.allPositives]);
				// setup next timer 
				next = Math.floor(perm.perm.length / sample);
			}
		}
		// add the last point
		ROC.push([1,1]);
		// return ROC
		return ROC;
	}
    
	//#     - `num = result.auc(sample)` -- get AUC of the current curve
	this.auc = function (sample) {
		// default sample size is 10
		sample = sample || 10;
        // get the curve
        var curve = this.curve(sample);
        // compute the area
        var result = 0;
        for (var i = 1; i < curve.length; i++) {
            // get edge points
            var left = curve[i-1];
            var right = curve[i];
            // first the rectangle bellow
            result = result + (right[0] - left[0]) * left[1];
            // an then the triangle above 
            result = result + (right[0] - left[0]) * (right[1] - left[1]) / 2;
        }
        return result;
    }
    
    //#     - `num = result.breakEvenPoint()` -- get break-even point, which is number where precision and recall intersect
    this.breakEvenPoint = function () {
		// sort according to predictions
		var perm = this.predictions.sortPerm(false);
		// maintaining the results as we go along
		var TP = 0, FP = 0, TN = this.allNegatives, FN = this.allPositives;
        var minDiff = 1.0, bep = -1.0;
		// go over the sorted results
		for (var i = 0; i < perm.perm.length; i++) {
			// get the ground
			var ground = this.grounds[perm.perm[i]];
			// update TP/FP counts according to the ground
			if (ground > 0) { TP++; FN--; } else { FP++; TN--; }
            // do the update
            if ((TP + FP) > 0 && (TP + FN) > 0 && TP > 0) {
                // compute current precision and recall
                var precision = TP / (TP + FP);
                var recall = TP / (TP + FN);
                // see if we need to update current bep
                var diff = Math.abs(precision - recall);
                if (diff < minDiff) { minDiff = diff; bep = (precision + recall) / 2; }
            }
        }        
        return bep;
    }
    
    //#     - `num = result.bestF1()` -- gets threshold for prediction score, which results in the highest F1
    this.bestF1 = function () {
		// sort according to predictions
		var perm = this.predictions.sortPerm(false);
		// maintaining the results as we go along
		var TP = 0, FP = 0, TN = this.allNegatives, FN = this.allPositives;
        var maxF1 = 0.0, prediction = -1.0;
		// go over the sorted results
		for (var i = 0; i < perm.perm.length; i++) {
			// get the ground
			var ground = this.grounds[perm.perm[i]];
			// update TP/FP counts according to the ground
			if (ground > 0) { TP++; FN--; } else { FP++; TN--; }
            // do the update
            if ((TP + FP) > 0 && (TP + FN) > 0 && TP > 0) {
                // compute current precision, recall and F1
                var precision = TP / (TP + FP);
                var recall = TP / (TP + FN);
                var f1 = 2 * precision * recall / (precision + recall);
                // see if we need to update max F1
                if (f1 > maxF1) { maxF1 = f1; prediction = perm.vec[i]; }
            }
        }        
        return prediction;
    };
	    
	//#     - `result.report(sample)` -- output to screen
	this.report = function (sample) {
		// default sample size is 10
		sample = sample || 10;
		// get the curve
		var curve = this.curve(sample);
		// print to console
        console.log("FPR - TPR");
		for (var i = 0; i < curve.length; i++) {
		 	console.log(curve[i][0] + " - " + curve[i][1]);
        }        
	};
	
	//#     - `result.reportCSV(fnm, sample)` -- save as CSV to file `fnm`
	this.reportCSV = function (fnm, sample) {
		// default sample size is 10
		sample = sample || 10;
		// get the curve
		var curve = this.curve(sample);
		// save
		fs.writeCsv(fs.openWrite(fnm), curve).close();
	};
};

//#- `cf = new analytics.confusionMatrix(cats)` -- for tracking confusion between label classification
exports.confusionMatrix = function (cats) {
    //#     - `cf.cats` -- categories we are tracking
    this.cats = cats;
    //#     - `cf.matrix` -- confusion matrix
    this.matrix = la.newMat({rows: cats.length, cols: cats.length});
    
    // get category name to id
    this.getCatId = function (cat) {
        for (var i = 0; i < cats.length; i++) {
            if (cats[i] === cat) {
                return i;
            }
        }
        return -1;
    };
    
    //#     - `cf.count(correct, predicted)` -- update matrix with new prediction
    this.count = function(correct, predicted) {
        var row = this.getCatId(correct);
        if (row == -1) { console.log("Unknown category '" + correct + "'"); }
        var col = this.getCatId(predicted);
        if (col == -1) { console.log("Unknown category '" + predicted + "'"); }
        this.matrix.put(row, col, this.matrix.at(row, col) + 1);
    };  
    
    //#     - `cf.report()` -- report on the current status
    this.report = function() {
        // get column width
        var max = 0;
        // first label name
        for (var i = 0; i < this.cats.length; i++) {
            if (cats[i].length > max) { max = cats[i].length; }
        }
        // then max number
        for (var i = 0; i < this.cats.length; i++) {
            for (var j = 0; j < this.cats.length; j++) {
                var digits = Math.ceil(Math.log(this.matrix.at(i, j)) / Math.LN10) + 2;
                if (digits > max) { max = digits; }
            }
        }
        // for prittyfying strings
        function addSpace(str, len) { 
            while (str.length < len) { 
                str = " " + str; 
            }
            return str;
        }
        // print header
        var header = addSpace("", max);
        for (var i = 0; i < this.cats.length; i++) {
            header = header + addSpace(this.cats[i], digits);
        }
        console.log(header);
        // print elements
        for (var i = 0; i < this.cats.length; i++) {
            var line = addSpace(this.cats[i], max);
            for (var j = 0; j < this.cats.length; j++) {
                line = line + addSpace("" + Math.round(this.matrix.at(i, j)), max);
            }
            console.log(line);
        }
    };
};

//#- `result = analytics.crossValidation(rs, features, target, folds)` -- creates a batch
//#     model for records from record set `rs` using `features; `target` is the
//#     target field and is assumed discrete; the result is a results object
//#     with the following API:
//#     - `result.target` -- an object with categories as keys and the following
//#       counts as members of these keys: `count`, `TP`, `TN`, `FP`, `FN`,
//#       `all()`, `precision()`, `recall()`, `accuracy()`.
//#     - `result.confusion` -- confusion matrix between categories
//#     - `result.report()` -- prints basic report on to the console
//#     - `result.reportCSV(fout)` -- prints CSV output to the `fout` output stream
exports.crossValidation = function (records, features, target, folds, limitCategories) {
	// create empty folds
	var fold = [];
	for (var i = 0; i < folds; i++) {
		fold.push(la.newIntVec());
	}
	// split records into folds
	records.shuffle(1);
	var fold_i = 0;
	for (var i = 0; i < records.length; i++) {
		fold[fold_i].push(records[i].$id);
		if (++fold_i == folds) { fold_i = 0; }
	} 
	// do cross validation
	var cfyRes = [];
    var globalTargetList = [];
	for (var fold_i = 0; fold_i < folds; fold_i++) {		
		// prepare train and test record sets
		var train = la.newIntVec();
		var test = la.newIntVec();
		for (var i = 0; i < folds; i++) {
			if (i == fold_i) {
				test.pushV(fold[i]);
			} else {
				train.pushV(fold[i]);
			}
		}
		var trainRecs = records.store.newRecSet(train);
		var testRecs = records.store.newRecSet(test);
		console.log("crossValidation", "Fold " + fold_i + ": " + trainRecs.length + " training and " + testRecs.length + " testing");
		// create model for the fold
		var model = exports.newBatchModel(trainRecs, features, target, limitCategories);
		// prepare test counts for each target
        // we create a new classificationScore for each fold, since else
        // we will be also counting results for a target that the current fold
        // may not have created a model for -- which doesn't seem very fair
        cfyRes[fold_i] = new exports.classificationScore(model.target);
        for (var i = 0; i < model.target.length; i++) {
            var cat = model.target[i];
            if (!util.isInArray(globalTargetList, cat)) {
                globalTargetList.push(cat);
            }
        }
		// evaluate predictions
		for (var i = 0; i < testRecs.length; i++) {
			var correct = testRecs[i][target.name];
			var predicted = model.predictLabels(testRecs[i]);
			cfyRes[fold_i].count(correct, predicted);
		}
		// report
		cfyRes[fold_i].report();
	}
    // merge all classification results
    var cfyResTotal = new exports.classificationScore(globalTargetList);
    var globaltarget = cfyResTotal.target;
    for (var fold_i = 0; fold_i < folds; fold_i++) {
        var foldtarget = cfyRes[fold_i].target;
        for (var cat in foldtarget) {
            globaltarget[cat].TP += foldtarget[cat].TP;
            globaltarget[cat].FP += foldtarget[cat].FP;
            globaltarget[cat].TN += foldtarget[cat].TN;
            globaltarget[cat].FN += foldtarget[cat].FN;
            globaltarget[cat].count += foldtarget[cat].count;
            globaltarget[cat].predictionCount += foldtarget[cat].predictionCount;
        } 
    }
	return cfyResTotal;
};


//#- `alModel = analytics.newActiveLearner(query, qRecSet, fRecSet, ftrSpace, settings)` -- initializes the
//#    active learning. The algorihm is run by calling `model.startLoop()`. The algorithm has two stages: query mode, where the algorithm suggests potential
//#    positive and negative examples based on the query text, and SVM mode, where the algorithm keeps
//#   selecting examples that are closest to the SVM margin (every time an example is labeled, the SVM
//#   is retrained.
//#   The inputs are: query (text), record set `qRecSet`, record set `fRecSet`,  the feature space `ftrSpace` and a 
//#   `settings`JSON object. The settings object specifies:`textField` (string) which is the name
//#    of the field in records that is used to create feature vectors, `nPos` (integer) and `nNeg` (integer) set the number of positive and negative
//#    examples that have to be identified in the query mode before the program enters SVM mode.
//#   We can set two additional parameters `querySampleSize` and `randomSampleSize` which specify the sizes of subsamples of qRecSet and fRecSet, where the rest of the data is ignored in the active learning.
//#   Final parameters are all SVM parameters (c, j, batchSize, maxIterations, maxTime, minDiff, verbose).
exports.newActiveLearner = function (query, qRecSet, fRecSet, ftrSpace, stts) {
    return new analytics.activeLearner(query, qRecSet, fRecSet, ftrSpace, stts);
};

function defarg(arg, defaultval) {
    return arg == null ? defaultval : arg;
}


exports.activeLearner = function (query, qRecSet, fRecSet, ftrSpace, stts) {
    var settings = defarg(stts, {});
    settings.nPos = defarg(stts.nPos, 2);
    settings.nNeg = defarg(stts.nNeg, 2);
    settings.textField = defarg(stts.textField, "Text");
    settings.querySampleSize = defarg(stts.querySampleSize, 1000);
    settings.randomSampleSize = defarg(stts.randomSampleSize, 0);
    settings.c = defarg(stts.c, 1.0);
    settings.j = defarg(stts.j, 1.0);
    settings.batchSize = defarg(stts.batchSize, 100);
    settings.maxIterations = defarg(stts.maxIterations, 100000);
    settings.maxTime = defarg(stts.maxTime, 1);
    settings.minDiff = defarg(stts.minDiff, 1e-6);
    settings.verbose = defarg(stts.verbose, false);
    
    // compute features or provide them    
    settings.extractFeatures = defarg(stts.extractFeatures, true);
    
    if (!settings.extractFeatures) {
        if (stts.uMat == null) { throw exception('settings uMat not provided, extractFeatures = false'); }
        if (stts.uRecSet == null) { throw exception('settings uRecSet not provided, extractFeatures = false'); }
        if (stts.querySpVec == null) { throw exception('settings querySpVec not provided, extractFeatures = false'); }
    }
        
    // QUERY MODE
    var queryMode = true;
    // bow similarity between query and training set

    var querySpVec;
    var uRecSet;
    var uMat;

    if (settings.extractFeatures) {
        var temp = {}; temp[settings.textField] = query;
        var queryRec = qRecSet.store.newRec(temp); // record
        querySpVec = ftrSpace.ftrSpVec(queryRec);
        uRecSet = qRecSet.sample(settings.querySampleSize).setunion(fRecSet.sample(settings.randomSampleSize));
        uMat = ftrSpace.ftrSpColMat(uRecSet);

    } else {
        querySpVec = stts.querySpVec;
        uRecSet = stts.uRecSet;
        uMat = stts.uMat;
    }


    querySpVec.normalize();
    uMat.normalizeCols();

    var X = la.newSpMat();
    var y = la.newVec();

    var simV = uMat.multiplyT(querySpVec); //similarities (q, recSet)
    var sortedSimV = simV.sortPerm(); //ascending sort
    var simVs = sortedSimV.vec; //sorted similarities (q, recSet)
    var simVp = sortedSimV.perm; //permutation of sorted similarities (q, recSet)
    //// counters for questions in query mode
    var nPosQ = 0; //for traversing simVp from the end
    var nNegQ = 0; //for traversing simVp from the start
        

    // SVM MODE
    var svm;
    var posIdxV = la.newIntVec(); //indices in recordSet
    var negIdxV = la.newIntVec(); //indices in recordSet

    var posRecIdV = la.newIntVec(); //record IDs
    var negRecIdV = la.newIntVec(); //record IDs

    var classVec = la.newVec({ "vals": uRecSet.length }); //svm scores for record set
    var resultVec = la.newVec({ "vals": uRecSet.length }); // non-absolute svm scores for record set


    //#   - `rs = alModel.getRecSet()` -- returns the record set that is being used (result of sampling)
    this.getRecSet = function () { return uRecSet };

    //#   - `idx = alModel.selectedQuestionIdx()` -- returns the index of the last selected question in alModel.getRecSet()
    this.selectedQuestionIdx = -1;

    //#   - `bool = alModel.getQueryMode()` -- returns true if in query mode, false otherwise (SVM mode)
    this.getQueryMode = function() { return queryMode; };

    //#   - `numArr = alModel.getPos(thresh)` -- given a `threshold` (number) return the indexes of records classified above it as a javascript array of numbers. Must be in SVM mode.
    this.getPos = function(threshold) {
      if(this.queryMode) { return null; } // must be in SVM mode to return results
      if(!threshold) { threshold = 0; }
      var posIdxArray = [];
      for (var recN = 0; recN < uRecSet.length; recN++) {
        if (resultVec[recN] >= threshold) {
          posIdxArray.push(recN);
        }
      }
      return posIdxArray;
    };

    this.debug = function () { eval(breakpoint);}

    this.getTop = function (limit) {
        if (this.queryMode) { return null; } // must be in SVM mode to return results
        if (!limit) { limit = 20; }
        var idxArray = [];
        var marginArray = [];
        var sorted = resultVec.sortPerm(false);
        for (var recN = 0; recN < uRecSet.length && recN < limit; recN++) {
            idxArray.push(sorted.perm[recN]);
            var val = sorted.vec[recN];
            val = val == Number.POSITIVE_INFINITY ? Number.MAX_VALUE : val;
            val = val == Number.NEGATIVE_INFINITY ? -Number.MAX_VALUE : val;
            marginArray.push(val);
        }
        return { posIdx: idxArray, margins: marginArray };
    };

    //#   - `objJSON = alModel.getSettings()` -- returns the settings object
    this.getSettings = function() {return settings;}

    // returns record set index of the unlabeled record that is closest to the margin
    //#   - `recSetIdx = alModel.selectQuestion()` -- returns `recSetIdx` - the index of the record in `recSet`, whose class is unknonw and requires user input
    this.selectQuestion = function () {
        if (posRecIdV.length >= settings.nPos && negRecIdV.length >= settings.nNeg) { queryMode = false; }
        if (queryMode) {
            if (posRecIdV.length < settings.nPos && nPosQ + 1 < uRecSet.length) {
                nPosQ = nPosQ + 1;
                console.say("query mode, try to get pos");
                this.selectedQuestionIdx = simVp[simVp.length - 1 - (nPosQ - 1)];
                return this.selectedQuestionIdx;
            }
            if (negRecIdV.length < settings.nNeg && nNegQ + 1 < uRecSet.length) {
                nNegQ = nNegQ + 1;
                // TODO if nNegQ == rRecSet.length, find a new sample
                console.say("query mode, try to get neg");
                this.selectedQuestionIdx = simVp[nNegQ - 1];
                return this.selectedQuestionIdx;
            }
        }
        else {
            ////call svm, get record closest to the margin            
            //console.startx(function (x) { return eval(x); });
            svm = analytics.trainSvmClassify(X, y, settings); //column examples, y float vector of +1/-1, default svm paramvals
            
            // mark positives
            for (var i = 0; i < posIdxV.length; i++) {
                classVec[posIdxV[i]] = Number.POSITIVE_INFINITY;
                resultVec[posIdxV[i]] = Number.POSITIVE_INFINITY;
            }
            // mark negatives
            for (var i = 0; i < negIdxV.length; i++) { 
              classVec[negIdxV[i]] = Number.POSITIVE_INFINITY;
              resultVec[negIdxV[i]] = Number.NEGATIVE_INFINITY; 
            }
            var posCount = posIdxV.length;
            var negCount = negIdxV.length;
            // classify unlabeled
            for (var recN = 0; recN < uRecSet.length; recN++) {
                if (classVec[recN] !== Number.POSITIVE_INFINITY) {
                    var svmMargin = svm.predict(uMat[recN]);
                    if (svmMargin > 0) {
                        posCount++;
                    } else {
                        negCount++;
                    }
                    classVec[recN] = Math.abs(svmMargin);
                    resultVec[recN] = svmMargin;
                }
            }
            var sorted = classVec.sortPerm();
            console.say("svm mode, margin: " + sorted.vec[0] + ", npos: " + posCount + ", nneg: " + negCount);
            this.selectedQuestionIdx = sorted.perm[0];
            return this.selectedQuestionIdx;
        }

    };
    // asks the user for class label given a record set index
    //#   - `alModel.getAnswer(ALAnswer, recSetIdx)` -- given user input `ALAnswer` (string) and `recSetIdx` (integer, result of model.selectQuestion) the training set is updated.
    //#      The user input should be either "y" (indicating that recSet[recSetIdx] is a positive example), "n" (negative example).
    this.getAnswer = function (ALanswer, recSetIdx) {
        //todo options: ?newQuery
        if (ALanswer === "y") {
            posIdxV.push(recSetIdx);
            posRecIdV.push(uRecSet[recSetIdx].$id);
            //X.push(ftrSpace.ftrSpVec(uRecSet[recSetIdx]));
            X.push(uMat[recSetIdx]);
            y.push(1.0);
        } else {
            negIdxV.push(recSetIdx);
            negRecIdV.push(uRecSet[recSetIdx].$id);
            //X.push(ftrSpace.ftrSpVec(uRecSet[recSetIdx]));
            X.push(uMat[recSetIdx]);
            y.push(-1.0);
        }
        // +k query // rank unlabeled according to query, ask for k most similar
        // -k query // rank unlabeled according to query, ask for k least similar
    };
    //#   - `alModel.startLoop()` -- starts the active learning loop in console
    this.startLoop = function () {
        while (true) {
            var recSetIdx = this.selectQuestion();
            console.say(uRecSet[recSetIdx].Text + ": y/(n)/stop?");
            var ALanswer = console.getln();
            if (ALanswer == "stop") { break; }
            if (posIdxV.length + negIdxV.length == uRecSet.length) { break; }
            this.getAnswer(ALanswer, recSetIdx);
        }
    };
    //#   - `alModel.saveSvmModel(fout)` -- saves the binary SVM model to an output stream `fout`. The algorithm must be in SVM mode.
    this.saveSvmModel = function (outputStream) {
        // must be in SVM mode
        if (queryMode) {
            console.say("AL.save: Must be in svm mode");
            return;
        }
        svm.save(outputStream);        
    };

    this.getWeights = function () {
        return svm.weights;
    }
    //this.saveLabeled
    //this.loadLabeled
};

//////////// RIDGE REGRESSION 
// solve a regularized least squares problem
//#- `ridgeRegressionModel = analytics.newRidgeRegression(kappa, dim, buffer)` -- solves a regularized ridge
//#  regression problem: min|X w - y|^2 + kappa |w|^2. The inputs to the algorithm are: `kappa`, the regularization parameter,
//#  `dim` the dimension of the model and (optional) parameter `buffer` (integer) which specifies
//#  the length of the window of tracked examples (useful in online mode). The model exposes the following functions:
exports.newRidgeRegression = function (kappa, dim, buffer) {
    return new analytics.ridgeRegression(kappa, dim, buffer);
};
exports.ridgeRegression = function (kappa, dim, buffer) {
    var X = [];
    var y = [];
    buffer = typeof buffer !== 'undefined' ? buffer : -1;
    var w = la.newVec({ "vals": dim });
    //#   - `ridgeRegressionModel.add(vec, num)` -- adds a vector `vec` and target `num` (number) to the training set
    this.add = function (x, target) {
        X.push(x);
        y.push(target);
        if (buffer > 0) {
            if (X.length > buffer) {
                this.forget(X.length - buffer);
            }
        }
    };
    //#   - `ridgeRegressionModel.addupdate(vec, num)` -- adds a vector `vec` and target `num` (number) to the training set and retrains the model
    this.addupdate = function (x, target) {
        this.add(x, target);
        this.update();
    }
    //#   - `ridgeRegressionModel.forget(n)` -- deletes first `n` (integer) examples from the training set
    this.forget = function (ndeleted) {
        ndeleted = typeof ndeleted !== 'undefined' ? ndeleted : 1;
        ndeleted = Math.min(X.length, ndeleted);
        X.splice(0, ndeleted);
        y.splice(0, ndeleted);
    };
    //#   - `ridgeRegressionModel.update()` -- recomputes the model
    this.update = function () {
        var A = this.getMatrix();
        var b = la.copyFltArrayToVec(y);
        w = this.compute(A, b);
    };
    //#   - `vec = ridgeRegressionModel.getModel()` -- returns the parameter vector `vec` (dense vector)
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
    //#   - `vec2 = ridgeRegressionModel.compute(mat, vec)` -- computes the model parameters `vec2`, given 
    //#    a row training example matrix `mat` and target vector `vec` (dense vector). The vector `vec2` solves min_vec2 |mat' vec2 - vec|^2 + kappa |vec2|^2.
    //#   - `vec2 = ridgeRegressionModel.compute(spMat, vec)` -- computes the model parameters `vec2`, given 
    //#    a row training example sparse matrix `spMat` and target vector `vec` (dense vector). The vector `vec2` solves min_vec2 |spMat' vec2 - vec|^2 + kappa |vec2|^2.
    this.compute = function (A, b) {
        var I = la.eye(A.cols);
        var coefs = (A.transpose().multiply(A).plus(I.multiply(kappa))).solve(A.transpose().multiply(b));
        return coefs;
    };
    //#   - `num = model.predict(vec)` -- predicts the target `num` (number), given feature vector `vec` based on the internal model parameters.
    this.predict = function (x) {
        return w.inner(x);
    };
};

///////// CLUSTERING BATCH K-MEANS
//#- `kmeansResult = analytics.kmeans(mat, k, iter)`-- solves the k-means algorithm based on a training
//#   matrix `mat`  where colums represent examples, `k` (integer) the number of centroids and
//#   `iter` (integer), the number of iterations. The result contains objects `kmeansResult.C` and `kmeansResult.idxv` - a dense centroid matrix, where each column
//#    is a cluster centroid and an index array of cluster indices for each data point.
//#- `kmeansResult = analytics.kmeans(spMat, k, iter)`-- solves the k-means algorithm based on a training
//#   sparse matrix `spMat`  where colums represent examples, `k` (integer) the number of centroids and
//#   `iter` (integer), the number of iterations. The result contains objects `kmeansResult.C` and `kmeansResult.idxv` - a dense centroid matrix, where each column
//#    is a cluster centroid and an index array of cluster indices for each data point.
exports.kmeans = function(X, k, iter) {
    // select random k columns of X, returns a dense C++ matrix
    var selectCols = function (X, k) {
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
    var getCentroids = function (X, idx, oldC) {
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
        var C = oldC;
        if (idxMat.cols == oldC.cols)
             C = ((X.multiply(idxMat)).plus(oldC)).multiply(sD); // modification
        return C;
    };


    // X: column examples
    // k: number of centroids
    // iter: number of iterations
    assert.ok(k <= X.cols, "k <= X.cols");
    var w = new util.clsStopwatch();
    var norX2 = la.square(X.colNorms());
    var initialCentroids = selectCols(X, k);
    var C = initialCentroids.C;
    var idxvOld = initialCentroids.idx;
    //printArray(idxvOld); // DEBUG
    var ones_n = la.ones(X.cols).multiply(0.5);
    var ones_k = la.ones(k).multiply(0.5);
    w.tic();
    for (var i = 0; i < iter; i++) {
        //console.say("iter: " + i);
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
            //console.say("converged at iter: " + i); //DEBUG
            break;
        }
        idxvOld = idxv.slice();
        C = getCentroids(X, idxv, C); //drag
    }
    w.toc("end");
    var result = {};
    result.C = C;
    result.idxv = idxv;
    return result;
};


////////////// ONLINE CLUSTERING (LLOYD ALGORITHM)
//#- `lloydModel = analytics.newLloyd(dim, k)` -- online clustering based on the Lloyd alogrithm. The model intialization
//#  requires `dim` (integer) the dimensionality of the inputs and `k` (integer), number of centroids. The model exposes the following functions:
exports.newLloyd = function (dim, k) {
    return new analytics.lloyd(dim, k);
}
exports.lloyd = function (dim, k) {
    // Private vars
    var C = la.genRandomMatrix(dim, k);//linalg.newMat({ "rows": dim, "cols": k, "random": true });;
    var counts = la.ones(k);
    var norC2 = la.square(C.colNorms());
    //#   - `lloydModel.init()` -- initializes the model with random centroids
    this.init = function () {
        C = la.genRandomMatrix(dim, k); //linalg.newMat({ "rows": dim, "cols": k, "random": true });
        counts = la.ones(k);
        norC2 = la.square(C.colNorms());
    };
    //#   - `mat = lloydModel.getC()` -- returns the centroid matrix `mat`
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
    //#   - `lloydModel.setC(mat)` -- sets the centroid matrix to matrix `mat`
    this.setC = function (C_) {
        C = la.newMat(C_);
        norC2 = la.square(C.colNorms());
    };
    //#   - `lloydModel.update(vec)` -- updates the model with a vector `vec`
    //#   - `lloydModel.update(spVec)` -- updates the model with a sparse vector `spVec`
    this.update = function (x) {
        var idx = this.getCentroidIdx(x);
        //C(:, idx) = 1/(counts[idx] + 1)* (counts[idx] * C(:, idx)  + x);
        var vec = ((C.getCol(idx).multiply(counts[idx])).plus(x)).multiply(1.0 / (counts[idx] + 1.0));
        C.setCol(idx, vec);
        counts[idx] = counts[idx] + 1;
        norC2[idx] = la.square(vec.norm());
    };
    //#   - `vec2 = lloydModel.getCentroid(vec)` -- returns the centroid `vec2` (dense vector) that is the closest to vector `vec`
    //#   - `vec2 = lloydModel.getCentroid(spVec)` -- returns the centroid `vec2` (dense vector) that is the closest to sparse vector `spVec`
    this.getCentroid = function (x) {
        var idx = this.getCentroidIdx(x);
        var vec = C.getCol(idx);
        return vec;
    };
    //#   - `idx = lloydModel.getCentroidIdx(vec)` -- returns the centroid index `idx` (integer) that corresponds to the centroid that is the closest to vector `vec`
    //#   - `idx = lloydModel.getCentroidIdx(spVec)` -- returns the centroid index `idx` (integer) that corresponds to the centroid that is the closest to sparse vector `spVec`
    this.getCentroidIdx = function (x) {
        var D = C.multiplyT(x);
        D = D.minus(norC2.multiply(0.5));
        var idxv = la.findMaxIdx(D);
        return idxv[0];
    };
};

/////////// perceptron : 0/1 classification
//#- `perceptronModel = analytics.newPerceptron(dim, use_bias)` -- the perceptron learning algorithm initialization requires
//#   specifying the problem dimensions `dim` (integer) and optionally `use_bias` (boolean, default=false). The
//#   model is used to solve classification tasks, where classifications are made by a function class(x) = sign(w'x + b). The following functions are exposed:
exports.newPerceptron = function (dim, use_bias) {
    return new analytics.perceptron(dim, use_bias);
};
exports.perceptron = function (dim, use_bias) {
    use_bias = typeof use_bias !== 'undefined' ? use_bias : false;
    var w = la.newVec({ "vals": dim });
    var b = 0;
    //#   - `perceptronModel.update(vec,num)` -- updates the internal parameters `w` and `b` based on the training feature vector `vec` and target class `num` (0 or 1)! 
    //#   - `perceptronModel.update(spVec,num)` -- updates the internal parameters `w` and `b` based on the training sparse feature vector `spVec` and target class `num` (0 or 1)! 
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
    //#   - `num = perceptronModel.predict(vec)` -- returns the prediction (0 or 1) for a vector `vec`
    //#   - `num = perceptronModel.predict(spVec)` -- returns the prediction (0 or 1) for a sparse vector `spVec`
    this.predict = function (x) {
        return (w.inner(x) + b) > 0 ? 1 : 0;
    };
    //#   - `perceptronParam = perceptronModel.getModel()` -- returns an object `perceptronParam` where `perceptronParam.w` (vector) and `perceptronParam.b` (bias) are the separating hyperplane normal and bias. 
    this.getModel = function () {
        var model;
        model.w = w;
        model.b = b;
        return model;
    };

};


///////// ONLINE KNN REGRESSION 
//#- `kNearestNeighbors = analytics.newKNearestNeighbors(k, buffer, power)`-- online regression based on knn alogrithm. The model intialization
//#  requires `k` (integer), number of nearest neighbors, optional parameter `buffer` (default is -1) and optional parameter `power` (default is 1), 
//#  when using inverse distance weighting average to compute prediction. The model exposes the following functions:
exports.newKNearestNeighbors = function (k, buffer, power) {
    return new analytics.kNearestNeighbors(k, buffer, power);
};
exports.kNearestNeighbors = function (k, buffer, power) {
    this.X = la.newMat();
    this.y = la.newVec();
    this.k = k;

    // Optional parameters
    var power = typeof power !== 'undefined' ? power : 1;
    var buffer = typeof buffer !== 'undefined' ? buffer : -1;

    // Internal vector logs to create X and y
    var matrixVec = [];
    var targetVec = [];

    //#   - `kNearestNeighbors.update(vec, num)` -- adds a vector `vec` and target `num` (number) to the "training" set
    this.update = function (vec, num) {
        //console.log("Updated..."); //DEBUG
        add(vec, num);
        this.X = getColMatrix();
        this.y = getTargetVec();
    }

    //#   - `num = kNearestNeighbors.predict(vec)` -- predicts the target `num` (number), given feature vector `vec` based on k nearest neighburs,
    //#   using simple average, or inverse distance weighting average, where `power` (intiger) is optional parameter.
    this.predict = function (vec) {
        if (this.X.cols < this.k) { return -1 };
        var neighbors = this.getNearestNeighbors(vec); //vector of indexes
        var targetVals = this.y.subVec(neighbors.perm);
        var prediction = getAverage(targetVals); // using simple average
        //var prediction = getIDWAverage(targetVals, neighbors.vec, power); // using inverse distance weighting average
        return prediction;
    }

    //#   - `object = kNearestNeighbors.getNearestNeighbors(vec)` -- findes k nearest neighbors. Returns object with two vectors: indexes `perm` (intVec) and values `vec` (vector)
    this.getNearestNeighbors = function (vec) {
        var distVec = la.pdist2(this.X, la.repvec(vec, 1, this.X.cols)).getCol(0);
        var sortRes = distVec.sortPerm(); // object with two vectors: values and indexes

        var result = new Object();
        var newPerm = la.newIntVec({ "vals": this.k, "mxvals": this.k });
        var newVec = la.newVec({ "vals": this.k, "mxvals": this.k });
        for (var ii = 0; ii < this.k; ii++) {
            newPerm[ii] = sortRes.perm[ii];
            newVec[ii] = sortRes.vec[ii];
        }
        result.perm = newPerm;
        result.vec = newVec;
        return result; // object with two vectors: values and indexes
    }

    // Calculate simple average
    var getAverage = function (vec) {
        var sum = vec.sum();
        var avr = sum / vec.length;
        return avr;
    }

    // Inverse distance weighting average
    var getIDWAverage = function (vec, dist, power) {
        var numerator = la.elementByElement(vec, dist, function (a, b) { return result = b == 0 ? a : a / Math.pow(b, power) }).sum();
        var denumerator = la.elementByElement(la.ones(dist.length), dist, function (a, b) { return result = b == 0 ? a : a / Math.pow(b, power) }).sum();
        return numerator / denumerator;
    }

    // Used for updating
    var add = function (x, target) {
        matrixVec.push(x);
        targetVec.push(target);
        if (buffer > 0) {
            if (matrixVec.length > buffer) {
                forget(matrixVec.length - buffer);
            }
        }
    }

    // Create row matrix from matrixVec array log
    var getMatrix = function () {
        if (matrixVec.length > 0) {
            var A = la.newMat({ "cols": matrixVec[0].length, "rows": matrixVec.length });
            for (var i = 0; i < matrixVec.length; i++) {
                A.setRow(i, matrixVec[i]);
            }
            return A;
        }
    };

    // Create column matrix from matrixVec array log
    var getColMatrix = function () {
        if (matrixVec.length > 0) {
            var A = la.newMat({ "cols": matrixVec.length, "rows": matrixVec[0].length });
            for (var i = 0; i < matrixVec.length; i++) {
                A.setCol(i, matrixVec[i]);
            }
            return A;
        }
    };

    // Forget function used in buffer. Deletes first `n` (integer) examples from the training set
    var forget = function (ndeleted) {
        ndeleted = typeof ndeleted !== 'undefined' ? ndeleted : 1;
        ndeleted = Math.min(matrixVec.length, ndeleted);
        matrixVec.splice(0, ndeleted);
        targetVec.splice(0, ndeleted);
    };

    // Create vector from targetVec array
    var getTargetVec = function () {
        return la.copyFltArrayToVec(targetVec);
    }
}


/////////// Kalman Filter
//#- `kf = analytics.newKalmanFilter(dynamParams, measureParams, controlParams)` -- the Kalman filter initialization procedure
//#   requires specifying the model dimensions `dynamParams` (integer), measurement dimension `measureParams` (integer) and
//#   the `controlParams` control dimension. Algorithm works in two steps - prediction (short time prediction according to the
//#   specified model) and correction. The following functions are exposed:
exports.newKalmanFilter = function (dynamParams, measureParams, controlParams) {
    return new analytics.kalmanFilter(dynamParams, measureParams, controlParams);
}
exports.kalmanFilter = function (dynamParams, measureParams, controlParams) {
    var CP = controlParams;
    var MP = measureParams;
    var DP = dynamParams;

    // CP should be >= 0
    CP = Math.max(CP, 0);

    var statePre = la.newVec({ "vals": DP, "mxvals": DP }); // prior state vector (after prediction and before measurement update)
    var statePost = la.newVec({ "vals": DP, "mxvals": DP }); // post state vector (after measurement update)
    var transitionMatrix = la.newMat({ "cols": DP, "rows": DP }); // transition matrix (model)

    var processNoiseCov = la.newMat({ "cols": DP, "rows": DP }); // process noise covariance
    var measurementMatrix = la.newMat({ "cols": DP, "rows": MP }); // measurement matrix
    var measurementNoiseCov = la.newMat({ "cols": MP, "rows": MP }); // measurement noise covariance
     
    var errorCovPre = la.newMat({ "cols": DP, "rows": DP }); // error covariance after prediction
    var errorCovPost = la.newMat({ "cols": DP, "rows": DP }); // error covariance after update
    var gain = la.newMat({ "cols": MP, "rows": DP }); 

    var controlMatrix;

    if (CP > 0)
        controlMatrix = la.newMat({ "cols": CP, "rows": DP }); // control matrix

    // temporary matrices used for calculation
    var temp1VV = la.newMat({ "cols": DP, "rows": DP });
    var temp2VV = la.newMat({ "cols": DP, "rows": MP });
    var temp3VV = la.newMat({ "cols": MP, "rows": MP });
    var itemp3VV = la.newMat({ "cols": MP, "rows": MP });
    var temp4VV = la.newMat({ "cols": DP, "rows": MP });

    var temp1V = la.newVec();
    var temp2V = la.newVec();

    //#   - `kf.setStatePost(_val)` -- sets the post state (DP) vector.
    this.setStatePost = function (_statePost) {
        statePost = _statePost;
    };

    //#   - `kf.setTransitionMatrix(_val)` -- sets the transition (DP x DP) matrix.
    this.setTransitionMatrix = function (_transitionMatrix) {
        transitionMatrix = _transitionMatrix;
    };

    //#   - `kf.setMeasurementMatrix(_val)` -- sets the measurement (MP x DP) matrix.
    this.setMeasurementMatrix = function (_measurementMatrix) {
        measurementMatrix = _measurementMatrix;
    };

    //#   - `kf.setProcessNoiseCovPost(_val)` -- sets the process noise covariance (DP x DP) matrix.
    this.setProcessNoiseCov = function (_processNoiseCov) {
        processNoiseCov = _processNoiseCov;
    }

    //#   - `kf.setMeasurementNoiseCov(_val)` -- sets the measurement noise covariance (MP x MP) matrix.
    this.setMeasurementNoiseCov = function (_measurementNoiseCov) {
        measurementNoiseCov = _measurementNoiseCov;
    }

    //#   - `kf.setErrorCovPre(_val)` -- sets the pre error covariance (DP x DP) matrix.
    this.setErrorCovPre = function (_errorCovPre) {
        errorCovPre = _errorCovPre;
    }

    //#   - `kf.setErrorCovPost(_val)` -- sets the post error covariance (DP x DP) matrix.
    this.setErrorCovPost = function (_errorCovPost) {
        errorCovPost = _errorCovPost;
    }

    //#   - `statePost = kf.correct(measurement)` -- returns a corrected state vector `statePost` where `measurement` is the measurement vector.
    this.setControlMatrix = function (_controlMatrix) {
        controlMatrix = _controlMatrix;
    }

    //#   - `statePre = kf.predict(control)` -- returns a predicted state vector `statePre` where `control` is the control vector (normally not set).
    this.predict = function (control) {
        // update the state: x'(k) = A * x(k)
        statePre = transitionMatrix.multiply(statePost);

        // x'(k) = x'(k) + B * u(k)
        if (control.length) {
            temp1V = controlMatrix.multiply(control);
            temp2V = statePre.plus(temp1V);
        }

        // update error covariance matrices: temp1 = A * P(k)
        temp1VV = transitionMatrix.multiply(errorCovPost);

        // P'(k) = temp1 * At + Q
        errorCovPre = temp1VV.multiply(transitionMatrix.transpose()).plus(processNoiseCov);

        // return statePre
        return statePre;
    };

    //#   - `statePost = kf.correct(measurement)` -- returns a corrected state vector `statePost` where `measurement` is the measurement vector.
    this.correct = function (measurement) {
        // temp2 = H * P'(k)
        temp2VV = measurementMatrix.multiply(errorCovPre);
        
        // temp3 = temp2 * Ht + R
        temp3VV = temp2VV.multiply(measurementMatrix.transpose()).plus(measurementNoiseCov);

        // temp4 = inv(temp3) * temp2 = Kt(k)
        itemp3VV = la.inverseSVD(temp3VV);
        temp4VV = itemp3VV.multiply(temp2VV);

        // K(k)
        gain = temp4VV.transpose();

        // temp2V = z(k) - H*x'(k)
        temp1V = measurementMatrix.multiply(statePre);
        temp2V = measurement.minus(temp1V);

        // x(k) = x'(k) + K(k) * temp2V
        temp1V = gain.multiply(temp2V);     
        statePost = statePre.plus(temp1V);

        // P(k) = P'(k) - K(k) * temp2
        errorCovPost = errorCovPre.minus(gain.multiply(temp2VV));

        // return statePost
        return statePost;
    };

};

/////////// Extended Kalman Filter
//#- `ekf = analytics.newExtendedKalmanFilter(dynamParams, measureParams, controlParams)` -- the Extended Kalman filter 
//#   is used with non-linear models, which are specified through transition and measurement equation. The initialization procedure
//#   requires specifying the model dimensions `dynamParams` (integer), measurement dimension `measureParams` (integer) and
//#   the `controlParams` control dimension. Algorithm works in two steps - prediction (short time prediction according to the
//#   specified model) and correction. The following functions are exposed:
exports.newExtendedKalmanFilter = function (dynamParams, measureParams, controlParams, parameterN) {
    return new analytics.extendedKalmanFilter(dynamParams, measureParams, controlParams, parameterN);
}
exports.extendedKalmanFilter = function (dynamParams, measureParams, controlParams, parameterN) {
    var CP = controlParams;
    var MP = measureParams;
    var DP = dynamParams;
    var P = parameterN;

    // CP should be >= 0
    CP = Math.max(CP, 0);

    var statePre = la.newVec({ "vals": DP, "mxvals": DP }); // prior state vector (after prediction and before measurement update)
    var statePost = la.newVec({ "vals": DP, "mxvals": DP }); // post state vector (after measurement update)
    var transitionMatrix = la.newMat({ "cols": DP, "rows": DP }); // transition matrix (model)

    var processNoiseCov = la.newMat({ "cols": DP, "rows": DP }); // process noise covariance
    var measurementMatrix = la.newMat({ "cols": DP, "rows": MP }); // measurement matrix
    var measurementNoiseCov = la.newMat({ "cols": MP, "rows": MP }); // measurement noise covariance

    var errorCovPre = la.newMat({ "cols": DP, "rows": DP }); // error covariance after prediction
    var errorCovPost = la.newMat({ "cols": DP, "rows": DP }); // error covariance after update
    var gain = la.newMat({ "cols": MP, "rows": DP });
    var parameterV = la.newVec({ "vals": P, "mxvals": P }); // parameters vector

    var controlMatrix;

    if (CP > 0)
        controlMatrix = la.newMat({ "cols": CP, "rows": DP }); // control matrix

    // temporary matrices used for calculation
    var temp1VV = la.newMat({ "cols": DP, "rows": DP });
    var temp2VV = la.newMat({ "cols": DP, "rows": MP });
    var temp3VV = la.newMat({ "cols": MP, "rows": MP });
    var itemp3VV = la.newMat({ "cols": MP, "rows": MP });
    var temp4VV = la.newMat({ "cols": DP, "rows": MP });

    var temp1V = la.newVec();
    var temp2V = la.newVec();

    // virtual functions
    // this.observationEq = function () { };
    // this.transitionEq = function () { };
    var observationEq;
    var transitionEq;

    //#   - `ekf.setTransitionEq(_val)` -- sets transition equation for EKF (`_val` is a function).
    this.setTransitionEq = function (_transitionEq) {
        this.transitionEq = _transitionEq;
    };

    //#   - `ekf.setObservationEq(_val)` -- sets observation equation for EKF (`_val` is a function).
    this.setObservationEq = function (_observationEq) {
        this.observationEq = _observationEq;
    };

    //#   - `ekf.setParameterV(_val)` -- sets parameter vector of size `parameterN`.
    this.setParameterV = function (_parameterV) {
        parameterV = _parameterV;
    };

    //#   - `ekf.getParameterV()` -- gets parameter vector.
    this.getParameterV = function () {
        return parameterV;
    };


    //#   - `ekf.setStatePost(_val)` -- sets the post state (DP) vector.
    this.setStatePost = function (_statePost) {
        statePost = _statePost;
    };

    //#   - `ekf.getStatePost()` -- returns the statePost vector.
    this.getStatePost = function () {
        return statePost;
    };

    //#   - `ekf.setTransitionMatrix(_val)` -- sets the transition (DP x DP) matrix.
    this.setTransitionMatrix = function (_transitionMatrix) {
        transitionMatrix = _transitionMatrix;
    };

    //#   - `ekf.setMeasurementMatrix(_val)` -- sets the measurement (MP x DP) matrix.
    this.setMeasurementMatrix = function (_measurementMatrix) {
        measurementMatrix = _measurementMatrix;
    };

    //#   - `ekf.setProcessNoiseCovPost(_val)` -- sets the process noise covariance (DP x DP) matrix.
    this.setProcessNoiseCov = function (_processNoiseCov) {
        processNoiseCov = _processNoiseCov;
    }

    //#   - `ekf.setMeasurementNoiseCov(_val)` -- sets the measurement noise covariance (MP x MP) matrix.
    this.setMeasurementNoiseCov = function (_measurementNoiseCov) {
        measurementNoiseCov = _measurementNoiseCov;
    }

    //#   - `ekf.setErrorCovPre(_val)` -- sets the pre error covariance (DP x DP) matrix.
    this.setErrorCovPre = function (_errorCovPre) {
        errorCovPre = _errorCovPre;
    }
    
    //#   - `ekf.setErrorCovPost(_val)` -- sets the post error covariance (DP x DP) matrix.
    this.setErrorCovPost = function (_errorCovPost) {
        errorCovPost = _errorCovPost;
    }

    //#   - `statePost = ekf.correct(measurement)` -- returns a corrected state vector `statePost` where `measurement` is the measurement vector.
    this.setControlMatrix = function (_controlMatrix) {
        controlMatrix = _controlMatrix;
    }

    //#   - `statePre = ekf.predict(control)` -- returns a predicted state vector `statePre` where `control` is the control vector (normally not set).
    this.predict = function (control) {
        // update the state: x'(k) = A * x(k)
        // Standard KF: statePre = transitionMatrix.multiply(statePost);
        statePre = this.transitionEq();

        // x'(k) = x'(k) + B * u(k)
        if (control.length) {
            temp1V = controlMatrix.multiply(control);
            temp2V = statePre.plus(temp1V);
        }

        // update error covariance matrices: temp1 = A * P(k)
        temp1VV = transitionMatrix.multiply(errorCovPost);

        // P'(k) = temp1 * At + Q
        errorCovPre = temp1VV.multiply(transitionMatrix.transpose()).plus(processNoiseCov);

        // return statePre
        return statePre;
    };

    //#   - `statePost = ekf.correct(measurement)` -- returns a corrected state vector `statePost` where `measurement` is the measurement vector.
    this.correct = function (measurement) {
        // temp2 = H * P'(k)
        temp2VV = measurementMatrix.multiply(errorCovPre);

        // temp3 = temp2 * Ht + R
        temp3VV = temp2VV.multiply(measurementMatrix.transpose()).plus(measurementNoiseCov);

        // temp4 = inv(temp3) * temp2 = Kt(k)
        itemp3VV = la.inverseSVD(temp3VV);
        temp4VV = itemp3VV.multiply(temp2VV);

        // K(k)
        gain = temp4VV.transpose();

        // temp2V = z(k) - H*x'(k)
        // standard KF: temp1V = measurementMatrix.multiply(statePre);
        temp1V = this.observationEq();
        temp2V = measurement.minus(temp1V);

        // x(k) = x'(k) + K(k) * temp2V
        temp1V = gain.multiply(temp2V);
        statePost = statePre.plus(temp1V);

        // P(k) = P'(k) - K(k) * temp2
        errorCovPost = errorCovPre.minus(gain.multiply(temp2VV));

        // return statePost
        return statePost;
    };

};

///////// Rocchio classification 
//# - `model = analytics.newRocchio(trainMat, targetVec)` -- train Rocchio model 
//      using columns from `trainMat` as feature vectors and values from `targetVec` to 
//      indicate positive (>0) or negative (<=0) class. Returned `model` has a function 
//      `predict`, which returns +1 for positive and -1 for negative classification. 
//      Rocchio centroids are stored as `model.pos` and `model.neg`.
exports.newRocchio = function (trainMat, targetVec, params) {
	// parse parameters; magic default values according to C. Buckley, G. Salton, and J. Allan.
	// The effect of adding relevance information in a relevance feedback environment. SIGIR-94, 1994
	var alpha = params.alpha ? params.alpha : 16;
	var beta = params.beta ? params.beta : 4;
	// get column norms, used in filter to normalize columns
	var colNorm = trainMat.colNorms();
	// go over matrix and add them to the appropriate centroid
	var posFilter = la.newVec({ mxvals: trainMat.cols });
	var negFilter = la.newVec({ mxvals: trainMat.cols });
	var posCount = 0, negCount = 0;
	for (var i = 0; i < trainMat.cols; i++) {
		if (targetVec[i] > 0) {
			posCount++;
			posFilter.push(1.0 / colNorm[i]);
			negFilter.push(0.0);
		} else {
			negCount++;
			posFilter.push(0.0);
			negFilter.push(1.0 / colNorm[i]);
		}
	}
    console.log(" - Rocchio training: P=" + posCount + ", N=" + negCount);

	// check we have some of each class
	if (posCount == 0 || negCount == 0) { 
		console.log("Not enough positive and/or negative examples: P=" + posCount + " / N=" + negCount);
		return null;
	}
	// prepare sum positives and negatives
	var posSum = trainMat.multiply(posFilter);
	var negSum = trainMat.multiply(negFilter);
	// prepare model centroids
	var posModel = posSum.multiply(alpha / posCount).minus(negSum.multiply(beta / negCount));
	var negModel = negSum.multiply(alpha / negCount).minus(posSum.multiply(beta / posCount));
	// prepare and return model object with centroids
	return {
		pos: posModel,
		neg: negModel,
		predict: function (vec) {
			var posScore = this.pos.inner(vec);
			var negScore = this.neg.inner(vec);
			return (posScore > negScore) ? 1 : -1;
		}
	};
}

///////// Learning with positive and unlabeled examples
//# - `result = newPULearning(trainMat, posVec, params)` -- apply PU learning 
//      to `trainMat` using  positive examples in `posVec` (value > 0) to 
//      bootstrap a model and classfiy rest of examples. Parameters `params` 
//      are passed to first step Rocchio model (alpha and beta) and to second 
//      step SVM model (C, j, time, ...). Result contains `result.classVec` 
//      containing 1 for positive and -1 for negative examples, according to 
//      bootstraped SVM, and the SVM model itself as `result.svm`. Implemented 
//      based on **Li, Xiaoli, and Bing Liu. "Learning to classify texts using 
//      positive and unlabeled data." IJCAI. Vol. 3. 2003.**
exports.newPULearning = function (trainMat, posVec, params) {
	// We start by preparing classification result vector, with what we know (positive data)
	var cols = trainMat.cols, posCount = 0, negCount = 0;
	var classVec = la.newVec({ mxvals: cols });
	for (var i = 0; i < cols; i++) { classVec.push(posVec[i] > 0 ? 1 : 0); }
	// (1) Do Rocchio to get initial set of reliable negative data
	console.log(" - training Rocchio model");
	// we assumed all unlabeled vectors as negative for now
	var rocchioTargetVec = la.newVec({ mxvals: cols });
	for (var i = 0; i < cols; i++) { rocchioTargetVec.push(classVec[i] > 0 ? 1 : -1); }
	// train rocchio model
	var rocchio = exports.newRocchio(trainMat, rocchioTargetVec, params)
	// apply to get reliable negative data
	for (var i = 0; i < cols; i++) { 
		if (classVec[i] > 0) {
			posCount++;
		} else {
			if (rocchio.predict(trainMat[i]) < 0) {
				classVec[i] = -1;
				negCount++;
			}
		}
	}
	console.log(" - after step 1: P=" + posCount + ", N=" + negCount + ", U=" + (cols-posCount-negCount));
	// (2) use this to train SVM model and apply it to remaining unlabeled data
	// TODO: iterate SVM models and check for divergence
	console.log(" - training SVM model");
	// train SVM model
	var svm = analytics.trainSvmClassify(trainMat, classVec, params);
	// apply to all data
    posCount = 0; negCount = 0;
	for (var i = 0; i < cols; i++) {
		//if (classVec[i] == 0) {
			// unlabeled example, let's classify it!
			if (svm.predict(trainMat[i]) > 0) {
				classVec[i] = 1;
				posCount++;
			} else {
				classVec[i] = -1;
				negCount++;
			}
		//}
	}
	console.log(" - after step 2: P=" + posCount + ", N=" + negCount);	
	// we are complete
	return { "classVec" : classVec, "svm" : svm };
}
