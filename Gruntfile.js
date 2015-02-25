module.exports = function(grunt) {
  grunt.initConfig({
    browserify: {
      default: {
        files: {
          'dist/quickconnect.js': 'index.js'
        },
        options: {
          browserifyOptions: {
            debug: true,
            standalone: 'quickconnect'
          }
        }
      }
    },
    uglify: {
      default:{
        files: {
          'dist/quickconnect.min.js': "dist/quickconnect.js"
        }
      }
    },
    watch: {
      default: {
        files: ['index.js'],
        tasks: ['dist']
      }
    }
  });

  grunt.loadNpmTasks('grunt-browserify');
  grunt.loadNpmTasks('grunt-contrib-uglify');
  grunt.loadNpmTasks('grunt-contrib-watch');

  grunt.registerTask('dist', ['browserify', 'uglify'])
};
