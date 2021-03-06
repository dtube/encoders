const shell = require('shelljs');
const { spawn } = require('child_process');
const ipfsAPI = require('ipfs-http-client');
const fs = require('fs');
const hbjs = require('handbrake-js')
var config = require('./config.js')

var ipfsIp = process.env.IPFSIP || '127.0.0.1';
var ipfsPort = process.env.IPFSPORT || '5001';
var ipfsProtocol = process.env.IPFSPROTOCOL || 'http';
var ipfsOnlyHash = config.onlyHash || false;
if (process.env.IPFSONLYHASH) ipfsOnlyHash = true
console.log(ipfsOnlyHash)

var cmds = {
	ffprobe_cmds: {
		createCmdString: (filePath) => {
			str1 = "ffprobe -v error -of default=nw=1 -show_entries stream_tags=rotate:format=size,duration:stream=index,codec_name,pix_fmt,height,width,duration,nb_frames,avg_frame_rate,bit_rate "
			str2 = " -print_format json"

			return str1 + filePath + str2
		}
	},
	ipfs_cmds: {
		// uploads file to ipfs, second parameter is the property to update within encoder response
		ipfsUpload: (filePath, prop, onlyHash) => {
			//Connceting to our http api
			console.log(filePath)
			const ipfs = ipfsAPI(ipfsIp, ipfsPort, { protocol: ipfsProtocol })
			let videoFile = fs.readFileSync(filePath);
			//let testBuffer = new Buffer.from(videoFile);
			var opt = {}
			if (ipfsOnlyHash) opt["only-hash"] = ipfsOnlyHash
			if (onlyHash) opt["only-hash"] = onlyHash
			ipfs.add(videoFile, opt, function (err, file) {
				if (err) {
					console.log(err);
					process.exit();
				}
				// updating relevant encoder response fields
				cmds.setObjPropToValue(cmds.encoderResponse, prop + ".progress", "100.00%");
				cmds.setObjPropToValue(cmds.encoderResponse, prop + ".lastTimeProgress", Date());
				cmds.setObjPropToValue(cmds.encoderResponse, prop + ".step", "success");
				cmds.setObjPropToValue(cmds.encoderResponse, prop + ".hash", file[0].hash);
				cmds.setObjPropToValue(cmds.encoderResponse, prop + ".fileSize", file[0].size);
			});
		}
	},
	sprite_cmds: {
		sprite: (filePath, vidLength, resDir) => {
			cmds.sprite_cmds.wipeSpriteFolder(function() {
				var splitCmd = cmds.sprite_cmds.createVideoSplitCmd(filePath, vidLength, resDir);
				var montCmd = cmds.sprite_cmds.createMontageCmd(resDir);
				cmds.sprite_cmds.createSprite(splitCmd, montCmd);
			})
		},
		// splits video into images
		createVideoSplitCmd: (filePath, vidLength, resDir) => {
			let frameRate = 100 / vidLength
			if (frameRate > 1) frameRate = 1
			return `ffmpeg -y -i ` + filePath + ` -r ` + frameRate + ` -vf scale=128:72 -f image2 ` + resDir + `/img%03d`
		},
		wipeSpriteFolder: (cb) => {
			var cmd = 'rm ./sprite/*'
			shell.exec(cmd, function (code, stdout, stderr) {
				// code isn't 0 if error occurs
				if (code) {
					console.log(stderr);
					if (cb) cb()
					// process.exit();
				} else {
					if (cb) cb()
				}
			});
		},
		// concatenates all the images together
		createMontageCmd: (resDir) => {
			return `montage -mode concatenate -tile 1x ` + resDir + `/* ` + resDir + `/sprite.png`
		},
		createSprite: (splitCmd, montCmd) => {
			var timeoutfunc = setTimeout(() => {
				console.log("Sprite makin timed out")
				console.log("Killing container")
				process.exit();
			}, 600000);

			var cmd = splitCmd.split(' ')[0]
			var opts = splitCmd.split(' ')
			opts.splice(0,1)
			let ffmpeg = spawn(cmd, opts)
			ffmpeg.stderr.on('data', (data) => {
				data = ''+data
				data = data.split(' ')
				var percent = data[3]-2
				if (percent<0) percent=0
				if (percent>100) percent=100
				if (isNaN(percent)) return
				percent = percent+'.00%'
				cmds.encoderResponse.sprite.spriteCreation.progress = percent;
				console.log('sprite '+percent)
			})
			ffmpeg.on('close', (code) => {
				console.log(`ffmpeg child process exited with code ${code}`);
				if (code) {
					console.log(stderr);
					process.exit();
				} else {
					shell.exec(montCmd, function (code, stdout, stderr) {
						// code isn't 0 if error occurs
						if (code) {
							console.log(stderr);
							process.exit();
						} else {
							clearTimeout(timeoutfunc)
							console.log("sprite completed")
							//if no errors, update relevant encoder response fields and upload to ipfs
							cmds.encoderResponse.sprite.spriteCreation.progress = "100.00%";
							cmds.encoderResponse.sprite.spriteCreation.lastTimeProgress = Date();
							cmds.encoderResponse.sprite.spriteCreation.step = "Success";
							cmds.ipfs_cmds.ipfsUpload("./sprite/sprite.png", 'sprite.ipfsAddSprite');
							return stdout;
						}
					});
				}
			});
		}
	},
	encoder_cmds: {
		encoderSettings: {
			input: '',
			output: '',
			maxWidth: 0,
			maxHeight: 0,
			optimize: true,
			format: "av_mp4",
			encoder: "x264",
			rate: "30"
		},
		changeSettings: (filePath, resName, maxWidth, maxHeight) => {
			let settings = cmds.encoder_cmds.encoderSettings;
			settings.input = filePath;
			settings.output = resName;
			settings.maxWidth = maxWidth;
			settings.maxHeight = maxHeight;

			return settings

		},
		encode: (settings, encodedVideoIndex, cb) => {
			var timeoutfunc = setTimeout(() => {
				console.log("Encoder timed out")
				console.log("Killing container")
				process.exit();
			}, 1800000);

			let propIpfs = 'encodedVideos[' + String(encodedVideoIndex) + '].ipfsAddEncodeVideo';
			var outputName = settings.output;

			hbjs.spawn(settings)
				.on('error', err => {
					// console.log(err);
					cmds.encoderResponse.encodedVideos[encodedVideoIndex].encode.errorMessage = err;
					console.log("Exiting process, encoding error", err);
					process.exit();
				})
				.on('progress', progress => {
					var percent = String(progress.percentComplete) + "%";
					console.log("Encoding #"+encodedVideoIndex+" progress: " + percent)
					cmds.encoderResponse.encodedVideos[encodedVideoIndex].encode.progress = percent
					cmds.encoderResponse.encodedVideos[encodedVideoIndex].encode.lastTimeProgress = Date();
				})
				.on('complete', () => {
					console.log("Encoding completed, video index: " + encodedVideoIndex)
					clearTimeout(timeoutfunc)
					// when complete, upload to ipfs
					cmds.ipfs_cmds.ipfsUpload(outputName, propIpfs);
					if (cb) cb();
				});
		}
	},
	encoderResponse: {
		finished: false,
		debugInfo: null,
		sourceStored: true,
		sourceAudioCpuEncoding: null,
		sourceVideoGpuEncoding: null,
		ipfsAddSourceVideo: {
			progress: null,
			encodeSize: "source",
			lastTimeProgress: null,
			errorMessage: null,
			step: "Init",
			positionInQueue: null,
			hash: null,
			fileSize: null
		},
		sprite: {
			spriteCreation: {
				progress: null,
				encodeSize: "source",
				lastTimeProgress: null,
				errorMessage: null,
				step: "Init",
				positionInQueue: null
			},
			ipfsAddSprite: {
				progress: null,
				encodeSize: "source",
				lastTimeProgress: null,
				errorMessage: null,
				step: "Init",
				positionInQueue: null,
				hash: null,
				fileSize: null
			}
		},
		encodedVideos: []
	},
	// adds encoded video data fields to encoder response
	addEncodedVideoData: (encodeSize) => {
		var num = encodeSize.length;

		for (let i = 0; i < num; i++) {
			cmds.encoderResponse.encodedVideos.push({
				encode: {
					progress: "Waiting in queue...",
					encodeSize: "",
					lastTimeProgress: null,
					errorMessage: null,
					step: "Waiting",
					positionInQueue: null
				},
				ipfsAddEncodeVideo: {
					progress: null,
					encodeSize: "",
					lastTimeProgress: null,
					errorMessage: null,
					step: "init",
					positionInQueue: null,
					hash: null,
					fileSize: null
				}
			});
			cmds.encoderResponse.encodedVideos[i].encode.encodeSize = encodeSize[i];
			cmds.encoderResponse.encodedVideos[i].ipfsAddEncodeVideo.encodeSize = encodeSize[i];
		}
	},
	// function for setting deep nested object property values
	setObjPropToValue: (obj, path, value) => {
		var i;
		path = path.split(/(?:\.|\[|\])+/);
		for (i = 0; i < path.length - 1; i++)
			obj = obj[path[i]];

		obj[path[i]] = value;
	},
	moveFiles: (filePath, numOfEncodedVids) => {
		var oldEncodedVidPaths = ["fileres240.mp4", "fileres480.mp4"];

		if (cmds.encoderResponse.sourceStored) {
			var is = fs.createReadStream(filePath);
			var os = fs.createWriteStream(config.pathLongTerm + cmds.encoderResponse.ipfsAddSourceVideo.hash);
			
			is.pipe(os);
			is.on('end', function () {
				fs.unlinkSync(filePath);
			});
		}

		for (let i = 0; i < numOfEncodedVids; i++) {
			is = fs.createReadStream(oldEncodedVidPaths[i]);
			os = fs.createWriteStream(config.pathLongTerm + cmds.encoderResponse.encodedVideos[i].ipfsAddEncodeVideo.hash);

			is.pipe(os);
			is.on('end', function () {
				console.log(filePath, cmds.encoderResponse.encodedVideos[i].ipfsAddEncodeVideo)
				cmds.symlink(
					cmds.encoderResponse.encodedVideos[i].ipfsAddEncodeVideo.hash,
					config.pathLongTerm+cmds.encoderResponse.ipfsAddSourceVideo.hash+"_"+cmds.encoderResponse.encodedVideos[i].ipfsAddEncodeVideo.encodeSize,
					function(err) {
						console.log('symlinked '+cmds.encoderResponse.ipfsAddSourceVideo.hash+"_"+cmds.encoderResponse.encodedVideos[i].ipfsAddEncodeVideo.encodeSize)
					}
				)
				fs.unlinkSync(oldEncodedVidPaths[i]);
			});
		}

		is = fs.createReadStream("./sprite/sprite.png");
		os = fs.createWriteStream(config.pathLongTerm + cmds.encoderResponse.sprite.ipfsAddSprite.hash);

		is.pipe(os);
		is.on('end', function () {
			fs.unlinkSync("./sprite/sprite.png");
		});
	},
	symlink: (source, linkName, cb) => {
		var cmd = 'ln -s '+source+' '+linkName
		shell.exec(cmd, function (code, stdout, stderr) {
			// code isn't 0 if error occurs
			if (code) {
				console.log(stderr);
				if (cb) cb()
				// process.exit();
			} else {
				if (cb) cb()
			}
		});
	},
	// checking encoder response values to ensure everything is done before setting finished to true
	checkIfFinished: (filePath) => {
		var numOfEncodedVids = cmds.encoderResponse.encodedVideos.length
		console.log("We should have encoded: " + numOfEncodedVids + " videos");
		var func = setInterval(() => {
			// creating an array of encoded video hashes to iterate through in the "if"
			var encodedVidsHash = [];
			for (let i = 0; i < numOfEncodedVids; i++) {
				encodedVidsHash.push(cmds.encoderResponse.encodedVideos[i].ipfsAddEncodeVideo.hash);
			}

			if (cmds.encoderResponse.ipfsAddSourceVideo.hash && cmds.encoderResponse.sprite.ipfsAddSprite.hash && encodedVidsHash.every((hash) => { return hash })) {				
				clearInterval(func);
				console.log("Moving files to long term storage")
				console.log(cmds.encoderResponse)
				cmds.moveFiles(filePath, numOfEncodedVids)
				// wait before setting finished to true and ending process
				setTimeout(() => {
					cmds.encoderResponse.finished = true;
					console.log("Encoder finished")
				}, 1000);
				setTimeout(() => {
					console.log("Killing container")
					process.exit();
				}, 10000);
			}
		}, 2000);
	}
}

module.exports = cmds
