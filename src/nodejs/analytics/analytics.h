#ifndef ANALYTICS_H_
#define ANALYTICS_H_

#ifndef BUILDING_NODE_EXTENSION
	#define BUILDING_NODE_EXTENSION
#endif

#include <node.h>
#include <node_object_wrap.h>
#include "../nodeutil.h"
#include "fs_nodejs.h"
#include "la_nodejs.h"
#include "qminer_ftr.h"
#include "mc.h"

///////////////////////////////
// QMiner-JavaScript-Support-Vector-Machine-Model
//#
//# ### Support Vector Machine model
//#
//# Holds SVM classification or regression model. This object is result of
//# `analytics.trainSvmClassify` or `analytics.trainSvmRegression`.
// TODO rewrite to JavaScript
class TNodeJsSvmModel : public node::ObjectWrap {
	friend class TNodeJsUtil;
private:
	static v8::Persistent <v8::Function> constructor;

	TStr Algorithm;
	double SvmCost;
	double SvmUnbalance;
	int SampleSize;
	int MxIter;
	int MxTime;
	double MnDiff;
	bool Verbose;
	PNotify Notify;

	TSvm::TLinModel* Model;

	TNodeJsSvmModel(const PJsonVal& ParamVal);
	TNodeJsSvmModel(TSIn& SIn);
	~TNodeJsSvmModel();

	static v8::Local<v8::Object> WrapInst(v8::Local<v8::Object> Obj, const PJsonVal& ParamVal);
	static v8::Local<v8::Object> WrapInst(v8::Local<v8::Object> Obj, TSIn& SIn);

public:
//	static v8::Local<v8::Object> New(const PJsonVal& ParamVal);
//	static v8::Local<v8::Object> New(TSIn& SIn);

	static void Init(v8::Handle<v8::Object> exports);

	JsDeclareFunction(New);

	//#
	//# **Functions and properties:**
	//#
	//#- `svmModel = svmModel.fit(X,y)` -- fits an SVM model
	JsDeclareFunction(fit);
    //#- `num = svmModel.predict(vec)` -- sends vector `vec` through the model and returns the prediction as a real number `num` (-1 or 1 for classification)
	//#- `num = svmModel.predict(spVec)` -- sends sparse vector `spVec` through the model and returns the prediction as a real number `num` (-1 or 1 for classification)
	JsDeclareFunction(predict);

	//#- `params = svmModel.getParams()` -- returns the parameters of this model as
	//#- a Javascript object
	JsDeclareFunction(getParams);
	//#- `svmModel = svmModel.getParams(params)` -- sets one or more parameters given
	//#- in the input argument `params` returns this
	JsDeclareFunction(setParams);

    //#- `vec = svmModel.weights` -- weights of the SVM linear model as a full vector `vec`
	JsDeclareProperty(weights);
    //#- `fout = svmModel.save(fout)` -- saves model to output stream `fout`. Returns `fout`.
	JsDeclareFunction(save);

private:
	void UpdateParams(const PJsonVal& ParamVal);
	PJsonVal GetParams() const;
	void Save(TSOut& SOut) const;
	void ClrModel();
};

///////////////////////////////
// QMiner-JavaScript-Recursive-Linear-Regression
//#
//# ### Recursive Linear Regression model
//#
//# Holds online regression model. This object is result of `analytics.newRecLinReg`.
class TNodeJsRecLinReg : public node::ObjectWrap {
	friend class TNodeJsUtil;
private:
	static v8::Persistent <v8::Function> constructor;

	TSignalProc::PRecLinReg Model;

	TNodeJsRecLinReg(const TSignalProc::PRecLinReg& Model);

	static v8::Local<v8::Object> WrapInst(const v8::Local<v8::Object> Obj, const TSignalProc::PRecLinReg& Model);

public:
//	static v8::Local<v8::Object> New(const TSignalProc::PRecLinReg& Model);

	static void Init(v8::Handle<v8::Object> exports);

	JsDeclareFunction(New);

	//#
	//# **Functions and properties:**
	//#
    //#- `recLinRegModel = recLinRegModel.learn(vec, num)` -- updates the model using full vector `vec` and target number `num`as training data. Returns self.
	JsDeclareFunction(learn);
    //#- `num = recLinRegModel.predict(vec)` -- sends vector `vec` through the
    //#     model and returns the prediction as a real number `num`
	JsDeclareFunction(predict);

	//#- `params = svmModel.getParams()` -- returns the parameters of this model as
	//#- a Javascript object
	JsDeclareFunction(getParams);

    //#- `vec = recLinRegModel.weights` -- weights of the linear model as a full vector `vec`
	JsDeclareProperty(weights);
    //#- `num = recLinRegModel.dim` -- dimensionality of the feature space on which this model works
	JsDeclareProperty(dim);
	//#- `fout = recLinRegModel.save(fout)` -- saves model to output stream `fout`. Returns `fout`.
	JsDeclareFunction(save);

private:
	PJsonVal GetParams() const;
};

////////////////////////////////////////////////////////
// Hierarchical Markov Chain model
class TNodeJsHMChain : public node::ObjectWrap, public TMc::OnStateChangedCallback {
	friend class TNodeJsUtil;
private:
	static v8::Persistent <v8::Function> constructor;

	TMc::PHierarchCtmc McModel;

	v8::Persistent<v8::Function> StateChangedCallback;

	TNodeJsHMChain(const TMc::PHierarchCtmc& McModel);
	TNodeJsHMChain(PSIn& SIn);

	~TNodeJsHMChain() { StateChangedCallback.Reset(); }

	static v8::Local<v8::Object> WrapInst(const v8::Local<v8::Object> Obj, const PJsonVal& ParamVal);
	static v8::Local<v8::Object> WrapInst(const v8::Local<v8::Object> Obj, PSIn& SIn);

public:
	static void Init(v8::Handle<v8::Object> exports);

	//#- `hmc = new analytics.HMarkovChain(config, ftrSpace)` -- Creates a new model.
	//#- `hmc = new analytics.HMarkovChain(base, fname)` -- Loads the model from file `fname`.
	//#- `hmc = new analytics.HMarkovChain(base, fin)` -- Loads the model from input stream `fin`.
	JsDeclareFunction(New);

	//#- `hmc.init(recSet)` -- Initializes the model with the provided record set.
	JsDeclareFunction(init);
	//#- `hmc.update(ftrVec, recTm)`
	JsDeclareFunction(update);
	//#- `hmc.toJSON()` -- Returns a JSON representation of the model
	JsDeclareFunction(toJSON);
	//#- `hmc.futureStates(level, startState[, time])` -- returns a vector of probabilities
	//#- of future states starting from `startState` in time `time`.
	//#- If time is not specified it returns the most likely next states.
	JsDeclareFunction(futureStates);

	JsDeclareFunction(getTransitionModel);
	//#- `currStateV = hmc.getCurrStates()` -- returns the current states through the hierarchy
	JsDeclareFunction(currStates);
	//#- `coords = hmc.fullCoords(stateId)` -- returns the coordinates of the state
	JsDeclareFunction(fullCoords);
	//#- `hmc.onStateChanged(function (stateV) {})` -- callback when the current state changes
	JsDeclareFunction(onStateChanged);

	//#- `hmc.save(fout)` -- Saves the model into the specified output stream.
	JsDeclareFunction(save);

	void OnStateChanged(const TIntFltPrV& StateIdHeightV);

private:
	void InitCallbacks();
};

#endif /* ANALYTICS_H_ */
